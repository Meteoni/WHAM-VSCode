const {test}=require('node:test'), assert=require('node:assert/strict'), Module=require('node:module');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{promisify}=require('node:util');
const path=require('node:path');

test('elevation probes are read-only, writes retain CLI streams, and gsudo cache is scoped and closed',async()=>{
  const launches=[],commands=[];let sudoMode=3,cancelUac=false,deny=false,cacheAvailable=false,cacheDisabled=false,alreadyElevated=false,cacheNeverReady=false,cancelStatus=false;
  const execFile=function(){};
  execFile[promisify.custom]=async(executable,args)=>{commands.push({executable,args});
    if(args[0]==='status'&&cancelStatus)throw Object.assign(Error('Aborted'),{code:'ABORT_ERR'});
    if(args[0]==='status')return {stdout:JSON.stringify({CallerPid:process.pid,CacheAvailable:cacheAvailable,IsElevated:alreadyElevated,CacheMode:cacheDisabled?'Disabled':'Explicit'}),stderr:''};
    if(args[0]==='cache'){
      if(cancelUac&&args[1]==='on')throw Object.assign(Error('Canceled'),{code:999});
      cacheAvailable=args[1]==='on'&&!cacheNeverReady;
    }
    return {stdout:executable.endsWith('reg.exe')?'Enabled REG_DWORD 0x'+sudoMode:executable.endsWith('gsudo.exe')?'gsudo v2.6.1':'Sudo 1.0',stderr:''};};
  const spawn=(executable,args)=>{
    launches.push({executable,args});
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};
    if(args[0]==='control'){
      setImmediate(()=>child.stdout.write('ready\n'));
      child.stdin.on('finish',()=>{child.stdout.end();child.emit('close',0);});return child;
    }
    child.stdin.on('finish',()=>setImmediate(()=>{
      if(args[0]==='run' && args[2].endsWith('gsudo.exe')){child.stdout.end();child.emit('close',cancelUac?999:0);return;}
      const cliArgs=args.slice(executable.endsWith('gsudo.exe')?8:executable.endsWith('sudo.exe')?6:3);
      assert.equal(cliArgs[0],'--app-root');assert.equal(cliArgs[2],'--json');
      child.stderr.write('[compile:x64] fixture progress\n');
      child.stdout.end(JSON.stringify(deny?{schemaVersion:1,success:false,error:{code:'COMPILER_FAILED',message:'Compilation failed',details:{output:'Permission denied'}}}:{schemaVersion:1,success:true,data:{id:'local@test'}}));
      child.emit('close',deny?7:0);
    }));return child;
  };
  const load=Module._load;
  Module._load=function(name,parent,...rest){if(parent?.filename===require.resolve('../dist/windhawk')&&name==='node:child_process')return{spawn,execFile};return load.call(this,name,parent,...rest);};
  let windhawk;try{delete require.cache[require.resolve('../dist/windhawk')];windhawk=require('../dist/windhawk');}finally{Module._load=load;}
  const gsudo={elevation:'gsudo',gsudoPath:path.resolve('gsudo.exe')};
  await windhawk.inspectElevation(gsudo);assert.equal(launches.length,0,'Setup probes do not request UAC');
  const output=[];
  for(let i=0;i<2;i++)assert.deepEqual(await windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source',text=>output.push(text),undefined,gsudo),{id:'local@test'});
  assert.equal(commands.filter(item=>item.args[0]==='cache'&&item.args[1]==='on').length,1,'One cache request per session');
  const cache=commands.find(item=>item.args[0]==='cache').args;
  assert.equal(cache[cache.indexOf('--pid')+1],String(process.pid));assert.equal(cache[cache.indexOf('--duration')+1],'-1');
  assert.equal(launches.filter(item=>item.executable.endsWith('gsudo.exe')&&item.args[4]==='worker').length,2);
  assert.ok(output.every(text=>text.startsWith('[compile:')),'Temporary elevation diagnostics are removed');
  cancelStatus=true;const launchesBeforeStatusCancel=launches.length;
  await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo),error=>error.code==='CANCELED');
  assert.equal(launches.length,launchesBeforeStatusCancel);cancelStatus=false;
  // A lost cache must be reopened instead of trusting a fulfilled promise.
  cacheAvailable=false;
  await Promise.all([windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo),windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo)]);
  assert.equal(commands.filter(item=>item.args[0]==='cache'&&item.args[1]==='on').length,2,'Concurrent writes share one replacement cache');
  await windhawk.closeElevationSessions();assert.ok(commands.some(item=>item.args.join(' ')==='cache off --pid '+process.pid));
  assert.ok(!commands.some(item=>item.args.includes('-k')),'Other gsudo caches are untouched');
  // Already available external approval is reused, without claiming ownership.
  cacheAvailable=true;const commandsBeforeExternal=commands.length;
  await windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo);
  await windhawk.closeElevationSessions();assert.ok(!commands.slice(commandsBeforeExternal).some(item=>item.args[0]==='cache'));
  cacheAvailable=false;cacheDisabled=true;const launchesBeforeDisabled=launches.length;
  await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo),/caching is disabled/);
  assert.equal(launches.length,launchesBeforeDisabled);cacheDisabled=false;
  alreadyElevated=true;const cacheCommandsBeforeElevated=commands.filter(item=>item.args[0]==='cache').length;
  await windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo);
  assert.equal(commands.filter(item=>item.args[0]==='cache').length,cacheCommandsBeforeElevated);alreadyElevated=false;
  cacheNeverReady=true;const launchesBeforeUnavailable=launches.length;
  await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,gsudo),/unavailable.*after starting/);
  assert.equal(launches.length,launchesBeforeUnavailable,'No worker launch when approval is unavailable');cacheNeverReady=false;
  const beforeRead=launches.length;await windhawk.readInstalledMod('C:/Windhawk','local@test').catch(()=>{});
  assert.equal(launches[beforeRead].args[0],'run','Reads stay unelevated');
  await windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,{elevation:'sudo',gsudoPath:''});
  assert.ok(launches.at(-1).executable.endsWith('sudo.exe'));assert.equal(launches.at(-1).args[0],'--inline');
  sudoMode=0;await assert.rejects(windhawk.inspectElevation({elevation:'sudo',gsudoPath:''}),/Inline mode/);
  deny=true;await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source'),/Choose an elevation method/);deny=false;
  cancelUac=true;await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source',undefined,undefined,gsudo),error=>error.code==='CANCELED');
  await windhawk.closeElevationSessions();
});


test('gsudo resolves quoted paths and Scoop installs when VS Code has stale PATH',async()=>{
  const originalEnvironment=Object.fromEntries(['PATH','SCOOP','SCOOP_GLOBAL','ProgramData'].map(key=>[key,process.env[key]]));
  const home=path.resolve('fixture-home'),programData=path.resolve('fixture-program-data');
  const files=new Set(),probes=[];
  const execFile=function(){};
  execFile[promisify.custom]=async(executable,args)=>{probes.push({executable,args});assert.deepEqual(args,['--version']);if(!files.has(path.normalize(executable)))throw Object.assign(Error('Missing'),{code:'ENOENT'});return {stdout:'gsudo v2.6.1',stderr:''};};
  const load=Module._load;
  Module._load=function(name,parent,...rest){
    if(parent?.filename===require.resolve('../dist/windhawk')){
      if(name==='node:child_process')return{execFile};
      if(name==='node:os')return{homedir:()=>home};
      if(name==='node:fs/promises')return{stat:async file=>{if(!files.has(path.normalize(file)))throw Object.assign(Error('Missing'),{code:'ENOENT'});return{isFile:()=>true};}};
    }
    return load.call(this,name,parent,...rest);
  };
  let windhawk;try{delete require.cache[require.resolve('../dist/windhawk')];windhawk=require('../dist/windhawk');}finally{Module._load=load;}
  try{
    process.env.PATH='';delete process.env.SCOOP;delete process.env.SCOOP_GLOBAL;process.env.ProgramData=programData;
    const userExe=path.join(home,'scoop/apps/gsudo/current/gsudo.exe');files.add(path.normalize(userExe));
    assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''})).executable,userExe,'Default Scoop installation works without inherited PATH');
    const configured=path.resolve('Tools With Spaces/gsudo.exe');files.add(configured);
    for(const quote of ['"',"'"])assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:'  '+quote+configured+quote+'  '})).executable,configured,'Matching pasted quotes are removed');
    await assert.rejects(windhawk.inspectElevation({elevation:'gsudo',gsudoPath:'"'+configured}),/select its gsudo/,'Unmatched quotes are rejected');
    process.env.PATH='  "'+path.dirname(configured)+'"  '+path.delimiter;
    assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''})).executable,configured,'PATH takes precedence over Scoop fallbacks');
    process.env.PATH='';files.clear();process.env.SCOOP=path.resolve('custom-scoop');
    const customExe=path.join(process.env.SCOOP,'apps/gsudo/current/gsudo.exe');files.add(customExe);
    assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''})).executable,customExe);
    files.clear();process.env.SCOOP_GLOBAL=path.resolve('custom-global-scoop');
    const globalExe=path.join(process.env.SCOOP_GLOBAL,'apps/gsudo/current/gsudo.exe');files.add(globalExe);
    assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''})).executable,globalExe);
    files.clear();delete process.env.SCOOP_GLOBAL;const defaultGlobal=path.join(programData,'scoop/apps/gsudo/current/gsudo.exe');files.add(defaultGlobal);
    assert.equal((await windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''})).executable,defaultGlobal);
    files.clear();await assert.rejects(windhawk.inspectElevation({elevation:'gsudo',gsudoPath:''}),/Install gsudo/);
    assert.ok(probes.every(probe=>probe.args[0]==='--version'),'Discovery does not open an elevation session');
  }finally{for(const [key,value]of Object.entries(originalEnvironment)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
