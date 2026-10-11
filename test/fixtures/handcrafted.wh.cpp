// WHAM@1 {"type":"include","id":1,"path":"src/a.h","original":"I2luY2x1ZGUgImEuaCIK","before":"","tail":""}
// WHAM@1 {"type":"include","id":2,"path":"src/b.h","original":"I2luY2x1ZGUgImIuaCIK","before":"","tail":"\n"}
int b;
// WHAM@1 {"type":"include-end","id":2}
int a;
// WHAM@1 {"type":"include-end","id":1}
int root;
// WHAM@1 {"type":"manifest","version":1,"root":"src/mod.cpp","files":[{"path":"src/mod.cpp","hash":"28f7bff899e3c4a7642b30577e373ef324f67d8bea696469e1437351e48e7f90","bom":false},{"path":"src/a.h","hash":"e02d4aa503c296d4dc3c23e3c5daf5cd4f825b6f8b208cc1951e36ce020e2ae9","bom":false},{"path":"src/b.h","hash":"bbdf9a41985f6d77d9f20758ec3876c923503fb3d714accbf5198ba19f4f12d1","bom":false}],"config":{"formatVersion":1,"sourceDirectory":"src","outputDirectory":"output","entries":["mod.cpp"],"exclude":[],"includeDirectories":["src"],"externalIncludes":[],"inlineAngleIncludes":false,"generate":"onSave","debounceMs":250},"tail":""}
