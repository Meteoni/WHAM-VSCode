const {test}=require('node:test'),assert=require('node:assert/strict'),Module=require('node:module');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream'),{promisify}=require('node:util');
const path=require('node:path');

test('CLI probes accept beta/RC, transport preserves split UTF-8, and launch uses the configured path',async()=>{
  const commands=[],launches=[];let version='2.0.0-beta.1', bridgeUnavailable=false, parserUnavailable=false, flagsUnavailable=false, configUnavailable=false, badArchive=false, modernUi=false, missingApp=false, launchDenied=false, shellDenied=false;
  const execFile=function(){};
  execFile[promisify.custom]=async(executable,args,options)=>{
    commands.push(args);
    if (configUnavailable && args.join(' ')==='mod config get --help') throw new Error('Unsupported configuration read');
    if(executable.endsWith('powershell.exe')){
      assert.ok(args.includes('-NonInteractive'));assert.equal(options.env.WHAM_LAUNCH_ROOT,'C:/定制 Windhawk');
      assert.equal(options.env.WHAM_LAUNCH_EXE,path.join('C:/定制 Windhawk',modernUi?'windhawk-ui.exe':'windhawk.exe'));
      assert.ok(!args.at(-1).includes('C:/定制'),'Executable paths are data, not interpolated shell code');
      if(shellDenied)throw new Error('Windows launch denied');return {stdout:'',stderr:''};
    }
    return {stdout:args[0]==='--version'?'windhawk-cli '+version:'Usage: supported command',stderr:''};
  };
  const spawn=(executable,args,options)=>{
    const child=new EventEmitter();child.kill=()=>{};child.unref=()=>{};
    if(options.stdio==='ignore'){
      launches.push({executable,args,options});setImmediate(()=>child.emit(launchDenied?'error':'spawn',launchDenied?Object.assign(new Error('Denied'),{code:'EACCES'}):undefined));return child;
    }
    child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();
    child.stdin.on('finish',()=>{
      const managed=args[0]==='run', target=managed?args[2]:executable, targetArgs=managed?args.slice(3):args;
      const cli=target.endsWith('windhawk-cli.exe');
      const input=child.stdin.read(),request=input?JSON.parse(input.toString()):{};
      const command=cli?targetArgs.slice(3):[];
      let result=!cli && request.command==='getCompileFlags'?['-std=c++23']:{name:'汉字 — العربية'};
      if(!cli && request.params?.source?.includes('wham-parser-probe'))result={metadata:{id:'wham-parser-probe'},errors:{},initialSettings:null};
      let envelope;
      if(cli && command[0]==='mod' && command[1]==='config') {
        result={id:command[3],config:{disabled:false}};
        if(command[3]==='local@missing')envelope={schemaVersion:1,success:false,error:{code:'MOD_NOT_INSTALLED',message:'Missing'}};
        if(command[3]==='local@denied')envelope={schemaVersion:1,success:false,error:{code:'ACCESS_DENIED',message:'Denied'}};
      }
      if(cli && command[0]==='data') {
        assert.ok(command.includes('--no-settings'));assert.ok(command.includes('--no-config'));assert.ok(command.includes('--no-app-settings'));
        assert.equal(command[command.indexOf('--mods')+1],'local@test');
        result={archive:JSON.stringify({format:badArchive?'unsupported':'windhawk-user-data-v1',mods:[{modId:'local@test',source:'汉字 source'},{modId:'local@other',source:'must ignore'}]})};
      }
      if(!cli && (bridgeUnavailable || request.command==='parseModSource'&&parserUnavailable || request.command==='getCompileFlags'&&flagsUnavailable))envelope={ok:false,error:{message:'Unsupported ABI'}};
      const bytes=Buffer.from(JSON.stringify(envelope??(cli?{schemaVersion:1,success:true,data:result}:{ok:true,result})));
      const split=bytes.indexOf(Buffer.from('汉'))+1;
      child.stdout.write(bytes.subarray(0,split));
      setImmediate(()=>{child.stdout.end(bytes.subarray(split));child.emit('close',0);});
    });return child;
  };
  const load=Module._load;
  Module._load=function(name,parent,...rest){
    if(parent?.filename===require.resolve('../dist/windhawk')){
      if(name==='node:child_process')return {execFile,spawn};
      if(name==='node:fs/promises')return {stat:async file=>{if(missingApp || file.endsWith('windhawk-ui.exe')&&!modernUi)throw Object.assign(new Error('Missing'),{code:'ENOENT'});return {isFile:()=>true};}};
    }
    return load.call(this,name,parent,...rest);
  };
  let windhawk;try{delete require.cache[require.resolve('../dist/windhawk')];windhawk=require('../dist/windhawk');}finally{Module._load=load;}
  for(const candidate of ['2.0.0-beta.1','2.0.0-rc.2','2.1.0']){
    version=candidate;const capabilities=await windhawk.inspectWindhawk('C:/定制 Windhawk');
    assert.equal(capabilities.cli,true);assert.equal(capabilities.parser,true);assert.equal(capabilities.version,candidate);
    assert.equal(capabilities.previewDirectory,undefined);
  }
  assert.ok(commands.some(args=>args.join(' ')==='mod install --help'));
  assert.ok(commands.some(args=>args.join(' ')==='mod enable --help'));
  assert.ok(commands.some(args=>args.join(' ')==='mod disable --help'));
  assert.ok(commands.some(args=>args.join(' ')==='mod config get --help'));
  assert.ok(!commands.some(args=>args[0]==='data'),'Freshness does not probe editable source export');
  assert.deepEqual(await windhawk.invokeWindhawkCore('C:/定制 Windhawk','parseModSource',{source:''}),{name:'汉字 — العربية'});
  assert.deepEqual(await windhawk.runWindhawkCli('C:/定制 Windhawk',['mod','enable','local@test'],'{}'),{name:'汉字 — العربية'});
  assert.deepEqual(await windhawk.readInstalledMod('C:/定制 Windhawk','local@test'),{config:{disabled:false}});
  assert.deepEqual(await windhawk.readInstalledMod('C:/定制 Windhawk','local@missing'),{config:null});
  await assert.rejects(windhawk.readInstalledMod('C:/定制 Windhawk','local@denied'),error=>error.code==='ACCESS_DENIED');
  parserUnavailable=true;let independent=await windhawk.inspectWindhawk('C:/定制 Windhawk');assert.equal(independent.parser,false);assert.deepEqual(independent.compileFlags,['-std=c++23']);
  parserUnavailable=false;flagsUnavailable=true;independent=await windhawk.inspectWindhawk('C:/定制 Windhawk');assert.equal(independent.parser,true);assert.equal(independent.compileFlags,undefined);
  flagsUnavailable=false;configUnavailable=true;independent=await windhawk.inspectWindhawk('C:/定制 Windhawk');assert.equal(independent.cli,false);assert.equal(independent.parser,true);configUnavailable=false;
  const streamed=[];await windhawk.runWindhawkCli('C:/定制 Windhawk',['mod','enable','local@test'],'{}',text=>streamed.push(text));assert.deepEqual(streamed,[],'JSON replies are not streamed into the log');
  bridgeUnavailable=true;
  const cliOnly=await windhawk.inspectWindhawk('C:/定制 Windhawk');
  assert.equal(cliOnly.cli,true);assert.equal(cliOnly.parser,false);assert.equal(cliOnly.notice,undefined);
  await assert.rejects(windhawk.invokeWindhawkCore('C:/定制 Windhawk','getModSettings'),/Unsupported Windhawk parsing command/);
  await windhawk.openWindhawk('C:/定制 Windhawk');
  assert.equal(launches[0].executable,path.join('C:/定制 Windhawk','windhawk.exe'));
  assert.deepEqual(launches[0].args,[]);assert.equal(launches[0].options.shell,false);assert.equal(launches[0].options.windowsHide,true);
  modernUi=true;await windhawk.openWindhawk('C:/定制 Windhawk');
  assert.equal(launches[1].executable,path.join('C:/定制 Windhawk','windhawk-ui.exe'));
  modernUi=false;launchDenied=true;await windhawk.openWindhawk('C:/定制 Windhawk');
  assert.ok(commands.at(-1).includes('-Command'),'Direct access denial uses Windows launch handling');
  shellDenied=true;await assert.rejects(windhawk.openWindhawk('C:/定制 Windhawk'),/Allow its Windows prompt/);
  const launchesBeforeMissing=launches.length;
  missingApp=true;await assert.rejects(windhawk.openWindhawk('C:/定制 Windhawk'),/Select its installation/);
  assert.equal(launches.length,launchesBeforeMissing,'A missing installation is not launched');
});

test('preview locale matches a bundled translation',()=>{
  const {previewLanguage}=require('../dist/windhawk');
  assert.equal(previewLanguage('zh-cn'),'zh-CN');assert.equal(previewLanguage('pt'),'pt-BR');
  assert.equal(previewLanguage('de-DE'),'de');assert.equal(previewLanguage('xx'),'en');
});
