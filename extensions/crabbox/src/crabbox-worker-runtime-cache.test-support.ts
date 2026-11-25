import fs from "node:fs";
export function cacheFixtureSource(owner: string) {
  const files = Object.fromEntries(
    [
      "node-host-launcher.mjs",
      "cli-invocation.mjs",
      "cli-parent-lifetime.mjs",
      "node-runtime-env.mjs",
      "gateway-shutdown-budget.mjs",
    ].map((n) => [n, fs.readFileSync(new URL("../../../" + n, import.meta.url), "utf8")]),
  );
  return (
    "const owner=" +
    JSON.stringify(owner) +
    ";\nconst launchers=" +
    JSON.stringify(files) +
    ";\n" +
    String.raw`
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');const {once}=require('node:events');
(async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'g139-cache-'));
 const root=path.join(home,'.openclaw-worker','node-runtimes');
 const state=path.join(home,'.openclaw','cloud-workers','cbx_cache_fixture');
 const digest={previous:'a'.repeat(64),current:'b'.repeat(64),saved:'c'.repeat(64),unused:'d'.repeat(64),argv:'e'.repeat(64),cwd:'1'.repeat(64),unknown:'f'.repeat(64),link:'2'.repeat(64)};
 const directory=k=>path.join(root,digest[k]);
 const packageRoot=k=>path.join(directory(k),'node_modules','openclaw');
 const cli=[
 'import fs from "node:fs";import path from "node:path";',
 'import {runNodeHostLauncher} from "./node-host-launcher.mjs";',
 'await runNodeHostLauncher({entryPath:process.argv[1],packageRoot:path.dirname(process.argv[1])});',
 'const args=process.argv.slice(2);',
 'if(args[0]==="--version")console.log("OpenClaw 2026.8.1");',
 'else if(args[0]==="node"&&args[1]==="identity")console.log(JSON.stringify({deviceId:"cache-device"}));',
 'else if(args[0]==="plugins"){}',
 'else {if(args[0]!=="hold")process.title="openclaw-connect";process.stdout.write("ready");setInterval(()=>{},60000);}'
 ].join('\n');
 const children=[];let currentPid;
 try {
  for(const key of ['previous','current','saved','unused','argv','cwd']){
   const pkg=packageRoot(key);fs.mkdirSync(pkg,{recursive:true});
   fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'openclaw',version:'2026.8.1',type:'module'}));
   fs.writeFileSync(path.join(pkg,'node-runtime.json'),JSON.stringify({buildId:'cache-current',openclawVersion:'2026.8.1',install:'bundle',platforms:[{platform:process.platform,arch:process.arch}]}));
   fs.writeFileSync(path.join(pkg,'node-runtime.manifest.json'),'[]');
   fs.writeFileSync(path.join(pkg,'openclaw.mjs'),cli);
   for(const [name,bytes] of Object.entries(launchers))fs.writeFileSync(path.join(pkg,name),bytes);
  }
  fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(state,'node.pid'),'99999999\n');
  fs.symlinkSync(directory('previous'),path.join(state,'runtime'),'dir');
  fs.writeFileSync(path.join(state,'workspace-sentinel'),'private workspace');
  const saved=path.join(home,'.openclaw','cloud-workers','cbx_saved');fs.mkdirSync(saved);fs.symlinkSync(directory('saved'),path.join(saved,'runtime'),'dir');
  const privateData=path.join(home,'private');fs.mkdirSync(privateData);fs.writeFileSync(path.join(privateData,'sentinel'),'private data');
  fs.symlinkSync(privateData,directory('link'),'dir');fs.mkdirSync(directory('unknown'));fs.writeFileSync(path.join(directory('unknown'),'sentinel'),'unknown entry');
  fs.mkdirSync(path.join(root,'node-bootstrap-inflight'));fs.writeFileSync(path.join(root,'node-bootstrap-inflight','sentinel'),'inflight');
  for(const key of ['argv','cwd']){
   const args=key==='argv'?[path.join(packageRoot(key),'openclaw.mjs'),'hold']:['-e','process.title="openclaw-node";process.stdout.write("ready");setInterval(()=>{},60000)'];
   const child=spawn(process.execPath,args,{cwd:key==='argv'?home:directory(key),stdio:['ignore','pipe','inherit']});children.push(child);await once(child.stdout,'data');
  }
  const input=path.join(home,'owner.cjs');fs.writeFileSync(input,owner);
  const result=spawnSync(process.execPath,[input],{cwd:home,env:{...process.env,HOME:home,OPENCLAW_STATE_DIR:state,CRABBOX_WORKER_BOOTSTRAP_TOKEN:'{}'},encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr);
  currentPid=Number(fs.readFileSync(path.join(state,'node.pid'),'utf8'));
  assert.notEqual(currentPid,99999999);assert.equal(fs.realpathSync(path.join(state,'runtime')),directory('current'));
  const exists=Object.fromEntries(Object.keys(digest).map(k=>[k,fs.existsSync(directory(k))]));
  assert.equal(exists.unused,false,'unused immutable runtime was not pruned');
  for(const key of ['previous','current','saved','argv','cwd','unknown','link'])assert.equal(exists[key],true,key+' must remain');
  assert.equal(fs.readFileSync(path.join(state,'workspace-sentinel'),'utf8'),'private workspace');
  assert.equal(fs.readFileSync(path.join(privateData,'sentinel'),'utf8'),'private data');
  assert.equal(fs.readFileSync(path.join(root,'node-bootstrap-inflight','sentinel'),'utf8'),'inflight');
  console.log(JSON.stringify({status:'PASS',exists,workspacePreserved:true,unknownAndStagingPreserved:true,realResumeLauncher:true}));
 } finally {
  if(!currentPid){try{const p=Number(fs.readFileSync(path.join(state,'node.pid'),'utf8'));if(p!==99999999)currentPid=p;}catch{}}
  if(currentPid){try{process.kill(-currentPid,'SIGTERM');}catch(e){if(e.code!=='ESRCH')throw e;}}
  for(const child of children){if(child.exitCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed;}}
  fs.rmSync(home,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
`
  );
}
