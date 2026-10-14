const {test}=require('node:test'), assert=require('node:assert/strict'), Module=require('node:module');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{promisify}=require('node:util');
const path=require('node:path');

test('elevation probes are read-only, writes retain CLI streams, and gsudo cache is scoped and closed',async()=>{
  const launches=[],commands=[];let sudoMode=3,cancelUac=false,deny=false;
  const execFile=function(){};
  execFile[promisify.custom]=async(executable,args)=>{commands.push({executable,args});if(cancelUac&&args[0]==='cache'&&args[1]==='on')throw Object.assign(Error('Canceled'),{code:999});return {stdout:executable.endsWith('reg.exe')?'Enabled REG_DWORD 0x'+sudoMode:executable.endsWith('gsudo.exe')?'gsudo v2.6.1':'Sudo 1.0',stderr:''};};
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
  const gsudo={elevation:'gsudo',gsudoPath:path.resolve('gsudo.exe'),reuseSession:true};
  await windhawk.inspectElevation(gsudo);assert.equal(launches.length,0,'Setup probes do not request UAC');
  const output=[];
  for(let i=0;i<2;i++)assert.deepEqual(await windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source',text=>output.push(text),undefined,gsudo),{id:'local@test'});
  assert.equal(commands.filter(item=>item.args[0]==='cache'&&item.args[1]==='on').length,1,'One cache request per session');
  const cache=commands.find(item=>item.args[0]==='cache').args;
  assert.equal(cache[cache.indexOf('--pid')+1],String(process.pid));assert.equal(cache[cache.indexOf('--duration')+1],'-1');
  assert.equal(launches.filter(item=>item.executable.endsWith('gsudo.exe')&&item.args[4]==='worker').length,2);
  assert.ok(output.every(text=>text.startsWith('[compile:')),'Only compiler stderr enters the log');
  await windhawk.closeElevationSessions();assert.ok(commands.some(item=>item.args.join(' ')==='cache off --pid '+process.pid));
  assert.ok(!commands.some(item=>item.args.includes('-k')),'Other gsudo caches are untouched');
  const beforeRead=launches.length;await windhawk.readInstalledMod('C:/Windhawk','local@test').catch(()=>{});
  assert.equal(launches[beforeRead].args[0],'run','Reads stay unelevated');
  await windhawk.runWindhawkCli('C:/Windhawk',['mod','disable','local@test'],undefined,undefined,undefined,{elevation:'sudo',gsudoPath:''});
  assert.ok(launches.at(-1).executable.endsWith('sudo.exe'));assert.equal(launches.at(-1).args[0],'--inline');
  sudoMode=0;await assert.rejects(windhawk.inspectElevation({elevation:'sudo',gsudoPath:''}),/Inline mode/);
  deny=true;await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source'),/Choose an elevation method/);deny=false;
  cancelUac=true;await assert.rejects(windhawk.runWindhawkCli('C:/Windhawk',['mod','install','--file','-'],'source',undefined,undefined,gsudo),error=>error.code==='CANCELED');
  await windhawk.closeElevationSessions();
});
