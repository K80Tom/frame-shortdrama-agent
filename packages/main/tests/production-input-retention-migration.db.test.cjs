const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { randomBytes } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { migrationSqlForExecution } = require('../dist/db/migrate');
test('036 backfills exact valid sources and atomically refuses an orphaned validated snapshot', {
  skip: process.env.DATABASE_ADMIN_URL ? false : 'isolated DATABASE_ADMIN_URL required',
}, async () => {
  const client = new Client({ connectionString: process.env.DATABASE_ADMIN_URL }); await client.connect();
  try {
    for (const valid of [false,true]) {
      await client.query('BEGIN');
      try {
        const schema = 'retention_upgrade_' + randomBytes(12).toString('hex');
        await client.query('CREATE SCHEMA ' + schema); await client.query('SET LOCAL search_path TO ' + schema + ',public');
        await client.query("SELECT set_config('lyra.system_bypass','on',true)");
        // Minimal pre-036 relational fixture; the real migration SQL (not a mock) runs unchanged below.
        await client.query(`CREATE TABLE script_versions(workspace_id text,project_id text,id text PRIMARY KEY);
          CREATE TABLE plan_revisions(workspace_id text,project_id text,script_version_id text,id text PRIMARY KEY);
          CREATE TABLE storyboard_revisions(workspace_id text,project_id text,script_version_id text,source_plan_revision_id text,id text PRIMARY KEY);
          CREATE TABLE production_input_snapshots(workspace_id text,id text,project_id text,episode_id text,snapshot_json jsonb,
            UNIQUE(workspace_id,project_id,episode_id,id));
          CREATE TABLE production_input_states(workspace_id text,snapshot_id text,state text)`);
        const workspace = 'ws_' + 'a'.repeat(32), manifest = { script:{versionId:'script-one'},plan:{versionId:'plan-one'},storyboard:{versionId:'board-one'} };
        await client.query('INSERT INTO production_input_snapshots VALUES($1,$2,$3,$4,$5)',[workspace,'snapshot-one','project-one','episode-one',manifest]);
        await client.query("INSERT INTO production_input_states VALUES($1,'snapshot-one','frozen')",[workspace]);
        if (valid) {
          await client.query("INSERT INTO script_versions VALUES($1,'project-one','script-one')",[workspace]);
          await client.query("INSERT INTO plan_revisions VALUES($1,'project-one','script-one','plan-one')",[workspace]);
          await client.query("INSERT INTO storyboard_revisions VALUES($1,'project-one','script-one','plan-one','board-one')",[workspace]);
        }
        const sql = migrationSqlForExecution('036_production_input_source_retention.sql',readFileSync(join(__dirname,'../migrations/036_production_input_source_retention.sql'),'utf8'));
        await client.query('SAVEPOINT apply_retention');
        if (!valid) {
          await assert.rejects(client.query(sql),e=>e.code==='23503');
          await client.query('ROLLBACK TO SAVEPOINT apply_retention');
          assert.equal((await client.query('SELECT to_regclass($1) AS name',[schema+'.production_input_source_refs'])).rows[0].name,null);
          assert.equal((await client.query('SELECT snapshot_json FROM production_input_snapshots')).rows[0].snapshot_json.storyboard.versionId,'board-one');
          assert.equal((await client.query("SELECT count(*)::integer AS n FROM pg_constraint WHERE conname='script_versions_input_source_identity' AND connamespace=$1::regnamespace",[schema])).rows[0].n,0);
        } else {
          await client.query(sql);
          const retained = (await client.query('SELECT * FROM production_input_source_refs')).rows[0];
          assert.equal(retained.script_version_id,'script-one'); assert.equal(retained.plan_revision_id,'plan-one'); assert.equal(retained.storyboard_revision_id,'board-one');
          await client.query('SAVEPOINT delete_source');
          await assert.rejects(client.query("DELETE FROM storyboard_revisions WHERE id='board-one'"),e=>e.code==='23503');
          await client.query('ROLLBACK TO SAVEPOINT delete_source');
        }
      } finally { await client.query('ROLLBACK'); } // also removes the transaction-local fixture schema
    }
  } finally { await client.end(); }
});

test('038 installs on empty historical scene refs and atomically rejects unprovable frozen scene refs',{
  skip:process.env.DATABASE_ADMIN_URL?false:'isolated DATABASE_ADMIN_URL required',
},async()=>{
  const client=new Client({connectionString:process.env.DATABASE_ADMIN_URL});await client.connect();
  try{
    for(const orphan of [false,true]){
      await client.query('BEGIN');
      try{
        const schema='director_upgrade_'+randomBytes(12).toString('hex');
        await client.query('CREATE SCHEMA '+schema);await client.query('SET LOCAL search_path TO '+schema+',public');
        await client.query("SELECT set_config('lyra.system_bypass','on',true)");
        // Only pre-038 table signatures are synthetic; run the actual normalized migration SQL.
        await client.query(`CREATE TABLE users(id text PRIMARY KEY);
          CREATE TABLE production_episodes(workspace_id text,project_id text,id text,UNIQUE(workspace_id,project_id,id));
          CREATE TABLE storyboard_revisions(workspace_id text,project_id text,script_version_id text,source_plan_revision_id text,id text,
            UNIQUE(workspace_id,project_id,script_version_id,source_plan_revision_id,id));
          CREATE TABLE production_input_snapshots(workspace_id text,project_id text,episode_id text,id text,snapshot_json jsonb,
            UNIQUE(workspace_id,project_id,episode_id,id));
          CREATE TABLE production_input_states(workspace_id text,snapshot_id text,state text);
          CREATE TABLE data_outbox_events(aggregate_type text CONSTRAINT data_outbox_events_aggregate_type_check CHECK(aggregate_type IN ('asset','production_input')))`);
        const workspace='ws_'+'a'.repeat(32),manifest={directorScenes:orphan?[{id:'scene_one',versionId:'version_one',digest:'a'.repeat(64)}]:[]};
        await client.query('INSERT INTO production_input_snapshots VALUES($1,$2,$3,$4,$5)',[workspace,'project_one','episode_one','snapshot_one',manifest]);
        await client.query("INSERT INTO production_input_states VALUES($1,'snapshot_one','frozen')",[workspace]);
        const sql=migrationSqlForExecution('038_director_scene_versions.sql',readFileSync(join(__dirname,'../migrations/038_director_scene_versions.sql'),'utf8'));
        await client.query('SAVEPOINT install_scene_versions');
        if(orphan){
          await assert.rejects(client.query(sql),e=>e.code==='23503');await client.query('ROLLBACK TO SAVEPOINT install_scene_versions');
          assert.equal((await client.query('SELECT to_regclass($1) AS name',[schema+'.director_scene_versions'])).rows[0].name,null);
          assert.equal((await client.query('SELECT to_regclass($1) AS name',[schema+'.production_input_director_scene_refs'])).rows[0].name,null);
          assert.deepEqual((await client.query('SELECT snapshot_json FROM production_input_snapshots')).rows[0].snapshot_json,manifest);
        }else{
          await client.query(sql);assert.equal((await client.query('SELECT count(*)::integer AS n FROM director_scene_versions')).rows[0].n,0);
          assert.equal((await client.query('SELECT count(*)::integer AS n FROM production_input_director_scene_refs')).rows[0].n,0);
          await client.query("INSERT INTO data_outbox_events VALUES('director_scene')");
        }
      }finally{await client.query('ROLLBACK');}
    }
  }finally{await client.end();}
});
test('044 never upgrades an unprovable provider selector into an internal object version',{
 skip:process.env.DATABASE_ADMIN_URL?false:'isolated DATABASE_ADMIN_URL required',
},async()=>{
 const client=new Client({connectionString:process.env.DATABASE_ADMIN_URL});await client.connect();
 try{for(const orphan of [false,true]){
  await client.query('BEGIN');try{
   const schema='object_upgrade_'+randomBytes(12).toString('hex');await client.query('CREATE SCHEMA '+schema);
   await client.query('SET LOCAL search_path TO '+schema+',public');await client.query("SELECT set_config('lyra.system_bypass','on',true)");
   await client.query(`CREATE TABLE users(id text PRIMARY KEY);
    CREATE TABLE jobs(workspace_id text,id text,state text,UNIQUE(workspace_id,id));
    CREATE TABLE object_records(workspace_id text,id text,status text,deleted_at timestamptz,UNIQUE(workspace_id,id));
    CREATE TABLE production_input_snapshots(workspace_id text,id text,UNIQUE(workspace_id,id));
    CREATE TABLE production_input_states(workspace_id text,snapshot_id text,state text);
    CREATE TABLE production_input_shots(workspace_id text,snapshot_id text,shot_version_id text);
    CREATE TABLE shot_spec_versions(workspace_id text,id text,spec_json jsonb);
    CREATE TABLE data_outbox_events(aggregate_type text CONSTRAINT data_outbox_events_aggregate_type_check CHECK(aggregate_type IN ('asset')))`);
   const workspace='ws_'+'a'.repeat(32),spec={assetPacks:orphan?[{media:[{objectId:'obj_'+'b'.repeat(32),objectVersionId:'provider-old',checksum:'c'.repeat(64)}]}]:[]};
   await client.query("INSERT INTO production_input_snapshots VALUES($1,'snapshot_one')",[workspace]);
   await client.query("INSERT INTO production_input_states VALUES($1,'snapshot_one','frozen')",[workspace]);
   await client.query("INSERT INTO production_input_shots VALUES($1,'snapshot_one','shotversion_one')",[workspace]);
   await client.query("INSERT INTO shot_spec_versions VALUES($1,'shotversion_one',$2)",[workspace,spec]);
   const sql=migrationSqlForExecution('044_object_versions.sql',readFileSync(join(__dirname,'../migrations/044_object_versions.sql'),'utf8'));
   await client.query('SAVEPOINT object_upgrade');
   if(orphan){
    await assert.rejects(client.query(sql),e=>e.code==='55000');await client.query('ROLLBACK TO SAVEPOINT object_upgrade');
    assert.equal((await client.query('SELECT to_regclass($1) AS name',[schema+'.object_versions'])).rows[0].name,null);
    assert.equal((await client.query('SELECT to_regclass($1) AS name',[schema+'.production_input_object_version_refs'])).rows[0].name,null);
    assert.deepEqual((await client.query('SELECT spec_json FROM shot_spec_versions')).rows[0].spec_json,spec);
   }else{await client.query(sql);assert.equal((await client.query('SELECT count(*)::integer AS n FROM object_versions')).rows[0].n,0);}
  }finally{await client.query('ROLLBACK');}
 }}finally{await client.end();}
});
