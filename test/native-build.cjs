// Optional Windows integration checks: no installed-state writes or DLL loading.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {runWindhawkProcess,invokeWindhawkCore}=require('../dist/windhawk');
const {checkModBuild}=require('../dist/compiler'),{parseDraftSource}=require('../dist/metadata');
(async()=>{
const root=process.argv[2];if(!root)throw Error('Pass a Windhawk installation path.');
const source=await fs.readFile(path.join(__dirname,'fixtures/modern-settings.wh.cpp'),'utf8');
const native=await invokeWindhawkCore(root,'parseModSource',{source,language:'en'});
assert.deepEqual(native,parseDraftSource(source,'fixture.cpp','en'),'Offline annotations match the native descriptor');
const args=['汉字 path','quoted "text"','trailing\\','',"apostrophe's"];
const encoded=await runWindhawkProcess(process.execPath,['-e','console.log(JSON.stringify(process.argv.slice(1)))',...args]);
assert.equal(encoded.code,0);assert.deepEqual(JSON.parse(encoded.stdout),args,'Managed process preserves Windows argv and UTF-8');
let descendant,controller=new AbortController();
const canceled=runWindhawkProcess(process.execPath,['-e',`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});process.on('SIGINT',()=>process.exit(9));console.log(child.pid);setInterval(()=>{},1000);`],undefined,{signal:controller.signal,onOutput:(text,channel)=>{if(channel==='stdout'){descendant=Number(text.trim());controller.abort();}}});
await assert.rejects(canceled,error=>error.code==='CANCELED');assert.ok(descendant>0);
let stillRunning=true;for(let attempt=0;attempt<30&&stillRunning;attempt++){try{process.kill(descendant,0);await new Promise(resolve=>setTimeout(resolve,100));}catch(error){if(error.code!=='ESRCH')throw error;stillRunning=false;}}
assert.equal(stillRunning,false,'Cancellation closes the owned child process tree');
await assert.rejects(runWindhawkProcess(process.execPath,['-e',"process.on('SIGINT',()=>process.exit(9));setInterval(()=>{},1000)"],undefined,{timeoutMs:300}),error=>error.code==='TIMED_OUT');
const mod='// ==WindhawkMod==\n// @id wham-test-build\n// @name Test build\n// @version 1.0\n// @architecture x86-64\n// ==/WindhawkMod==\nBOOL Wh_ModInit(){ Wh_Log(L"test"); return TRUE; }\n';
await checkModBuild(root,mod,new AbortController().signal,()=>{},'2.0.0-alpha.7');
const syntaxMod=mod.replace('// @architecture x86-64','// @architecture x86\n// @architecture x86-64\n// @architecture arm64\n// @compilerOptions -DVERIFY_FIXTURE=1 -lcomctl32')+'\n#ifndef VERIFY_FIXTURE\n#error Missing compilerOptions\n#endif\nextern int unresolved_for_syntax(); int syntax_only(){return unresolved_for_syntax();}\n';
await checkModBuild(root,syntaxMod,new AbortController().signal,()=>{},'2.0.0-alpha.7',true);
await assert.rejects(checkModBuild(root,mod+'extern int missing_link_symbol(); int needs_link(){return missing_link_symbol();}\n',new AbortController().signal,()=>{},'2.0.0-alpha.7'),error=>error.code==='COMPILER_FAILED' && /missing_link_symbol/.test(error.stderr));
console.log('Native checks passed: modern parser parity; Windows argv; cancellation and child cleanup; deadline; temporary DLL link; syntax checks for x86/x64/ARM64 with metadata flags; unresolved symbol rejection. No installed mod changed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
