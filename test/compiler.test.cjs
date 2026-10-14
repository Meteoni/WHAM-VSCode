const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),Module=require('node:module');
test('Test build resolves UTF-16 installation paths, links declared architectures, and cleans its scratch DLLs',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'wham-compiler-test-'));
  const relative=path.relative(os.tmpdir(),root);assert.ok(relative.startsWith('wham-compiler-test-')&&!relative.includes(path.sep));
  const calls=[];let fail=false,warnings=false;const load=Module._load;
  Module._load=function(name,parent,...rest){
    if(parent?.filename===require.resolve('../dist/compiler') && name==='./windhawk')return {...require('../dist/windhawk'),runWindhawkProcess:async(executable,args,input,options)=>{
      calls.push({executable,args,input,options});
      if(!fail&&!args.includes('-fsyntax-only'))await fs.writeFile(args[args.indexOf('-o')+1],'fixture DLL');
      return {code:fail?1:0,stdout:'',stderr:fail?'link error':warnings?'fixture.cpp:1:1: warning: fixture warning':''};
    }};
    return load.call(this,name,parent,...rest);
  };
  let check;try{delete require.cache[require.resolve('../dist/compiler')];check=require('../dist/compiler').checkModBuild;}finally{Module._load=load;}
  try{
    const ini='[Storage]\r\nCompilerPath=Toolchain\r\nEnginePath=Engine\\2.0.0\r\n';
    await fs.writeFile(path.join(root,'windhawk.ini'),Buffer.concat([Buffer.from([255,254]),Buffer.from(ini,'utf16le')]));
    const source='// ==WindhawkMod==\n// @id fixture\n// @name Fixture\n// @version 1.0\n// @architecture x86-64\n// @architecture arm64\n// @compilerOptions -lcomctl32 -DTEST="a b"\n// ==/WindhawkMod==\n';
    assert.deepEqual(await check(root,source,new AbortController().signal,()=>{},'2.0.0-alpha.7'),{warnings:false});
    assert.equal(calls.length,2);assert.deepEqual(calls.map(call=>call.args[call.args.indexOf('-target')+1]),['x86_64-w64-mingw32','aarch64-w64-mingw32']);
    for(const call of calls){
      assert.equal(call.executable,path.join(root,'Toolchain/bin/clang++.exe'));assert.ok(call.args.includes('-DWH_WINDHAWK_VERSION=0x02000000'));assert.ok(call.args.includes('-DTEST=a b'));assert.ok(call.args.includes('-shared'));assert.ok(call.args.some(arg=>arg.startsWith(path.join(root,'Engine/2.0.0'))&&arg.endsWith('windhawk.lib')));assert.equal(call.input,source);
      assert.equal(await fs.stat(call.options.cwd).catch(()=>undefined),undefined,'Scratch folder is removed');
    }
    const beforeSyntax=calls.length;
    await check(root,source,new AbortController().signal,()=>{},'2.0.0-alpha.7',true);
    const syntax=calls.slice(beforeSyntax);
    assert.deepEqual(syntax.map(call=>call.args[call.args.indexOf('-target')+1]),['x86_64-w64-mingw32','aarch64-w64-mingw32']);
    for(const [index,call]of syntax.entries()){
      assert.ok(call.args.includes('-fsyntax-only'));assert.ok(!call.args.includes('-shared'));assert.ok(!call.args.includes('-o'));
      for(const flag of calls[index].args.filter(arg=>arg.startsWith('-D')||arg==='-O2'))assert.ok(call.args.includes(flag),'Shared flag: '+flag);
      assert.ok(call.args.includes('-lcomctl32'));assert.equal(call.input,source);assert.equal(await fs.stat(call.options.cwd).catch(()=>undefined),undefined);
    }
    warnings=true;assert.deepEqual(await check(root,source,new AbortController().signal,()=>{},'2.0.0-alpha.7',true),{warnings:true});warnings=false;
    fail=true;await assert.rejects(check(root,source,new AbortController().signal,()=>{}),error=>error.code==='COMPILER_FAILED');
    assert.equal(await fs.stat(calls.at(-1).options.cwd).catch(()=>undefined),undefined,'Failed build is cleaned');
    for(const redirect of ['-o outside.dll','-Wl,-o,outside.dll','-Xlinker -o -Xlinker outside.dll','--for-linker=-ooutside.dll']){
      const before=calls.length;await assert.rejects(check(root,source.replace('-lcomctl32 -DTEST="a b"',redirect),new AbortController().signal,()=>{}),/output redirects/);assert.equal(calls.length,before);
    }
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
