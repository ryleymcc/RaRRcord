import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { authenticate } from '../worker/identity.ts';
import { localAuthRoute } from '../worker/local-auth.ts';
import { api } from '../worker/ra.ts';
const origin = 'https://rarrcord.api1.ca';
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('../drizzle/', import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) sqlite.exec(readFileSync(new URL('../drizzle/'+f,import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('../deploy/vps/0004_local_auth.sql',import.meta.url),'utf8'));
  const DB = {
    prepare(query) { const stmt=sqlite.prepare(query); return {bind(...args){return {first:async()=>stmt.get(...args)??null,all:async()=>({results:stmt.all(...args)}),run:async()=>({meta:{changes:Number(stmt.run(...args).changes)}}),rows:()=>stmt.all(...args)}}}; },
    async batch(stmts) { sqlite.exec('BEGIN'); try { const results=stmts.map(s=>({results:s.rows()})); sqlite.exec('COMMIT'); return results; } catch(e){sqlite.exec('ROLLBACK');throw e;} }
  };
  return {sqlite,env:{DB,RARRCORD_AUTH:'local',RARRCORD_PUBLIC_ORIGIN:origin,RARRCORD_LOCAL_OWNER:'admin',RARRCORD_OWNER_EMAIL:'admin@rarrcord.invalid',RARRCORD_OWNER_CODE:'owner-'.repeat(6),RARRCORD_REGISTRATION_CODE:'member-'.repeat(6)}};
}
const password='a very long password';
const authRequest=(data, cookie='', site=origin)=>new Request('http://internal/signin-with-chatgpt',{method:'POST',headers:{origin:site,'content-type':'application/x-www-form-urlencoded',cookie},body:new URLSearchParams(data)});
const cookies=r=>r.headers.getSetCookie().map(s=>s.split(';')[0]);
async function call(env,path,body,cookie='',extra={}) {
  const req=new Request('http://internal/api/ra/'+path,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json',cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)});
  return api(await authenticate(req,env),env);
}
test('local admin bootstrap, member approval, credential security and logout',async()=>{
  const {sqlite,env}=fixture();
  const register=(username,code)=>localAuthRoute(authRequest({action:'register',username,password,code}),env);
  assert.equal((await register('admin',env.RARRCORD_REGISTRATION_CODE)).status,403);
  assert.equal((await register('friend',env.RARRCORD_REGISTRATION_CODE)).status,403);
  assert.equal((await call(env,'session',undefined,'',{'x-rarrcord-user-id':'local:admin','oai-authenticated-user-id':'admin','oai-authenticated-user-email':'admin@rarrcord.invalid'})).status,401);
  const admin=await register('admin',env.RARRCORD_OWNER_CODE); assert.equal(admin.status,303);
  const idCookie=cookies(admin)[0]; assert.match(admin.headers.getSetCookie()[0],/HttpOnly; Secure; SameSite=Strict/);
  assert.notEqual(sqlite.prepare('SELECT password_hash FROM local_accounts').get().password_hash,password);
  assert.equal((await call(env,'enroll',{username:'other'},idCookie)).status,400);
  const enrolled=await call(env,'enroll',{username:'admin'},idCookie); assert.equal(enrolled.status,200); assert.equal((await enrolled.json()).user.role,'admin');
  const ownerCookie=idCookie+'; '+cookies(enrolled)[0];
  const member=await register('friend',env.RARRCORD_REGISTRATION_CODE); assert.equal(member.status,303);
  const memberCookie=cookies(member)[0];
  assert.equal((await (await call(env,'enroll',{username:'friend'},memberCookie)).json()).user.state,'pending');
  assert.equal((await call(env,'workspace',undefined,memberCookie)).status,403);
  assert.equal((await call(env,'admin',{action:'account',target:'local:friend',state:'approved',role:'member'},ownerCookie)).status,200);
  const approved=await call(env,'enroll',{},memberCookie); assert.equal((await approved.json()).active,true);
  const both=memberCookie+'; '+cookies(approved)[0];
  assert.equal((await call(env,'workspace',undefined,both)).status,200);
  assert.equal((await localAuthRoute(authRequest({action:'login',username:'friend',password:'wrong password here'}),env)).status,401);
  assert.equal((await localAuthRoute(authRequest({action:'login',username:'friend',password},'','https://evil.example'),env)).status,403);
  const logout=await call(env,'logout',{},both); assert.equal(logout.status,200); assert.equal(cookies(logout).length,2);
  assert.equal((await call(env,'session',undefined,both)).status,401);
  const login=await localAuthRoute(authRequest({action:'login',username:'friend',password}),env); assert.equal(login.status,303);
  const next=cookies(login)[0];
  assert.equal((await call(env,'admin',{action:'revoke',target:'local:friend'},ownerCookie)).status,200);
  assert.equal((await call(env,'session',undefined,next)).status,401);
});

test('local profile never publishes a credential supplied as display name; migration scrubs existing names',async()=>{
  const {sqlite,env}=fixture();
  const credential='test credential never public';
  const signed=await localAuthRoute(authRequest({action:'register',username:'admin',password:credential,code:env.RARRCORD_OWNER_CODE}),env);
  assert.equal(signed.status,303);
  const identity=cookies(signed)[0];
  const enrolled=await call(env,'enroll',{name:credential},identity);
  assert.equal(enrolled.status,200);
  assert.equal((await enrolled.json()).user.name,'admin');
  const session=identity+'; '+cookies(enrolled)[0];
  assert.equal((await call(env,'profile',{name:credential,status:'online'},session)).status,200);
  assert.equal(sqlite.prepare('SELECT name FROM users WHERE id=?').get('local:admin').name,'admin');
  const workspace=await call(env,'workspace',undefined,session);
  assert.equal(workspace.status,200);
  assert.ok(!(await workspace.text()).includes(credential));
  sqlite.prepare('UPDATE users SET name=? WHERE id=?').run(credential,'local:admin');
  sqlite.exec(readFileSync(new URL('../deploy/vps/0005_local_profile_privacy.sql',import.meta.url),'utf8'));
  assert.equal(sqlite.prepare('SELECT name FROM users WHERE id=?').get('local:admin').name,'admin');
  assert.equal(sqlite.prepare('SELECT count(*) n FROM local_sessions').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM sessions').get().n,0);
  assert.equal((await call(env,'session',undefined,session)).status,401);
});
