import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {normalizeWritePaths,writeConflict} from '../cli/lib/write-scope.mjs';

async function fixture(t,name){
  const dir=await mkdtemp(join(tmpdir(),name));t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'repo');await mkdir(join(root,'src','pkg'),{recursive:true});
  await writeFile(join(root,'src','pkg','index.ts'),'');
  return {dir,root};
}

test('scope protects aliases and subtree overlap and allows new files in independent trees',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'squad-scope-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=join(dir,'repo');await mkdir(join(root,'src'),{recursive:true});await writeFile(join(root,'src/a.ts'),'');
  await symlink(join(root,'src'),join(root,'alias'));await symlink(dir,join(root,'outside'));
  assert.deepEqual(await normalizeWritePaths(root),['.']);
  assert.deepEqual(await normalizeWritePaths(root,['alias/a.ts','src/a.ts']),['src/a.ts']);
  assert.deepEqual(await normalizeWritePaths(root,['new/deep/file.ts']),['new/deep/file.ts']);
  for(const value of [[],['../escape'],['/absolute'],['src/*.ts'],['outside/file']])await assert.rejects(normalizeWritePaths(root,value),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  assert.ok(writeConflict(['src'],['src/a.ts']));assert.ok(writeConflict(['.'],['anything']));
  assert.equal(writeConflict(['src/a.ts'],['src/b.ts']),null);assert.equal(writeConflict(['src'],['src-other']),null);
});

test('new files resolve through the nearest real ancestor while symlinks cannot leave the workspace',async t=>{
  const {dir,root}=await fixture(t,'squad-scope-real-');
  await symlink(join(root,'src','pkg'),join(root,'pkg-link'));
  await symlink(join(root,'src','pkg','index.ts'),join(root,'index-link.ts'));
  await symlink(dir,join(root,'escaped'));
  assert.deepEqual(await normalizeWritePaths(root,['pkg-link/created.ts']),['src/pkg/created.ts']);
  assert.deepEqual(await normalizeWritePaths(root,['index-link.ts']),['src/pkg/index.ts']);
  assert.deepEqual(await normalizeWritePaths(root,['new/deep/file.ts','new/deep/file.ts']),['new/deep/file.ts']);
  await assert.rejects(normalizeWritePaths(root,['escaped/new/file.ts']),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  await assert.rejects(normalizeWritePaths(root,['escaped/created.ts']),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  if(process.platform==='darwin'){
    assert.deepEqual(await normalizeWritePaths(root,['SRC/PKG/created.ts']),['src/pkg/created.ts']);
    assert.deepEqual(await normalizeWritePaths(root,['SRC/PKG/created.ts','src/pkg/created.ts']),['src/pkg/created.ts']);
  }
});

test('conflict treats parent directories and the default scope as overlaps but not name prefixes',()=>{
  assert.equal(writeConflict(['src/a.ts'],['src/a.ts']),'src/a.ts ↔ src/a.ts');
  assert.equal(writeConflict(['src'],['src/a.ts']),'src ↔ src/a.ts');
  assert.equal(writeConflict(['src/a'],['src/a/b/c.ts']),'src/a ↔ src/a/b/c.ts');
  assert.equal(writeConflict(['.'],['src']),'. ↔ src');
  assert.equal(writeConflict(['src'],['.']),'src ↔ .');
  assert.equal(writeConflict(['src/a.ts'],['src/a.tsx']),null);
  assert.equal(writeConflict(['src/a'],['src/ab/c.ts']),null);
  assert.equal(writeConflict(['docs'],['src']),null);
  assert.equal(writeConflict(['src/a'],['src/b','src/a/c.ts']),'src/a ↔ src/a/c.ts');
});

test('scope validation rejects globs, separators, empty values and absolute or escaping paths with one typed error',async t=>{
  const {root}=await fixture(t,'squad-scope-invalid-');
  for(const value of [[],[''],['  '],['**'],['src/**'],['src/*.ts'],['src/{a,b}.ts'],['src\\a.ts'],['a\0b'],['../escape'],['src/../escape'],['/etc/passwd']]){
    await assert.rejects(normalizeWritePaths(root,value),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  }
  await assert.rejects(normalizeWritePaths(root,'src/a.ts'),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  await assert.rejects(normalizeWritePaths(root,[42]),e=>e.code==='SQUAD_WRITE_PATHS_INVALID');
  assert.deepEqual(await normalizeWritePaths(root,['.']),['.']);
});
