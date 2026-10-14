// Optional Windows elevation test: only synthetic workers, never installed mods.
const assert=require('node:assert/strict');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const {runWindhawkProcess,closeElevationSessions}=require('../dist/windhawk');
(async()=>{
  const executable=process.argv[2];if(!executable)throw Error('Pass gsudo.exe, or a placeholder and sudo as the third argument. Windows may request UAC.');
  const elevation={elevation:process.argv[3]==='sudo'?'sudo':'gsudo',gsudoPath:executable,reuseSession:process.argv[3]!=='sudo'};
  try {
    const input='汉字 source with spaces\n';
    const result=await runWindhawkProcess(process.execPath,['-e',"let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',text=>input+=text);process.stdin.on('end',()=>{console.error('fixture progress');console.log(JSON.stringify({input,args:process.argv.slice(1)}));});",'汉字 path','quoted "text"'],input,{elevation});
    assert.equal(result.code,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{input,args:['汉字 path','quoted "text"']});assert.match(result.stderr,/fixture progress/);
    if(elevation.elevation==='gsudo'){
      const cache=await promisify(execFile)(executable,['status','--json'],{windowsHide:true});
      assert.equal(JSON.parse(cache.stdout).CacheAvailable,true,'The extension host can reuse this session cache: '+cache.stdout);
    }
    const controller=new AbortController();let descendant;
    await assert.rejects(runWindhawkProcess(process.execPath,['-e',"const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGINT',()=>process.exit(9));console.log(child.pid);setInterval(()=>{},1000);"],undefined,{elevation,signal:controller.signal,onOutput:(text,channel)=>{if(channel==='stdout'){descendant=Number(text.trim());controller.abort();}}}),error=>error.code==='CANCELED');
    assert.ok(descendant>0);
    // Access denied querying an elevated process is distinct from a surviving
    // process; inspect liveness from a synthetic elevated worker instead.
    const alive=await runWindhawkProcess(process.execPath,['-e',`try{process.kill(${descendant},0);console.log('alive');}catch(error){console.log(error.code);}`],undefined,{elevation});
    assert.equal(alive.stdout.trim(),'ESRCH','Stop removes elevated compiler descendants');
    console.log(elevation.elevation+' checks passed: Unicode stdin/argv, live stderr, cancellation, and elevated descendant cleanup'+(elevation.reuseSession?', plus session cache reuse':'')+'. No Windhawk mod changed.');
  } finally { await closeElevationSessions(); }
})().catch(error=>{console.error(error);process.exitCode=1;});
