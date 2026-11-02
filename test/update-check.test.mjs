import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  UPDATE_ENTRY_MODE,UPDATE_ENTRY_URL,UPDATE_PACKAGE,updateCheckView,
} from '../cli/lib/update-check.mjs';

async function fixture(manifest){
  const root=await mkdtemp(join(tmpdir(),'squad-update-check-'));
  const plugin=join(root,'plugin');
  await mkdir(join(plugin,'.codex-plugin'),{recursive:true});
  if(manifest!==undefined)await writeFile(join(plugin,'.codex-plugin','plugin.json'),JSON.stringify(manifest));
  return {root,plugin,async cleanup(){await rm(root,{recursive:true,force:true})}};
}

test('the public build reports the local version and a manual GitHub Releases entry',async()=>{
  const fx=await fixture({name:'codex-squad',version:'0.12.0'});
  try{
    const snapshot=await updateCheckView({pluginRoot:fx.plugin});
    assert.equal(snapshot.schemaVersion,1);
    assert.equal(snapshot.package,UPDATE_PACKAGE);
    assert.equal(snapshot.localVersion,'0.12.0');
    assert.equal(snapshot.localVersionError,null);
    assert.equal(snapshot.entry.url,UPDATE_ENTRY_URL);
    assert.equal(snapshot.entry.mode,'manual');
    assert.equal(snapshot.entry.url,'https://github.com/chenchen428/codex-squad/releases');
    assert.equal(snapshot.autoUpdate,false);
    assert.equal('latestVersion' in snapshot,false);
    assert.equal('status' in snapshot,false);
    assert.equal('updateAvailable' in snapshot,false);
    assert.equal('registry' in snapshot,false);
  }finally{await fx.cleanup()}
});

test('the entry URL is the public GitHub Releases page, not an internal host',()=>{
  const url=new URL(UPDATE_ENTRY_URL);
  assert.equal(url.protocol,'https:');
  assert.equal(url.hostname,'github.com');
  assert.equal(url.pathname,'/chenchen428/codex-squad/releases');
  assert.equal(UPDATE_ENTRY_MODE,'manual');
});

test('a failed local read never blocks the page and never invents a version',async()=>{
  for(const [name,manifest,code] of [
    ['missing manifest',undefined,'SQUAD_UPDATE_LOCAL_VERSION_MISSING'],
    ['manifest without version',{name:'codex-squad'},'SQUAD_UPDATE_LOCAL_VERSION_INVALID'],
    ['unparsable version',{name:'codex-squad',version:'0.9.x'},'SQUAD_UPDATE_LOCAL_VERSION_INVALID'],
  ]){
    const fx=await fixture(manifest);
    try{
      const snapshot=await updateCheckView({pluginRoot:fx.plugin});
      assert.equal(snapshot.localVersion,null,name);
      assert.equal(snapshot.localVersionError.code,code,name);
      assert.equal(snapshot.entry.url,UPDATE_ENTRY_URL,name);
      assert.equal(snapshot.autoUpdate,false,name);
    }finally{await fx.cleanup()}
  }
});

test('reading the version view performs no network request',async()=>{
  const fx=await fixture({name:'codex-squad',version:'0.12.0'});
  const original=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async()=>{calls+=1;throw new Error('network must not be used')};
  try{
    const snapshot=await updateCheckView({pluginRoot:fx.plugin});
    assert.equal(snapshot.localVersion,'0.12.0');
    assert.equal(calls,0);
  }finally{globalThis.fetch=original;await fx.cleanup()}
});
