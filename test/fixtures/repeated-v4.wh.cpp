// WHAM@4 begin 1: src/shared.h
// WHAM@4 transform 3: guard-open
#ifndef WHAM_ONCE_0EC212EC9F2F17D134DF26EB
#define WHAM_ONCE_0EC212EC9F2F17D134DF26EB
// WHAM@4 end-transform 3
// WHAM@4 transform 2: pragma-once
// WHAM@4 end-transform 2
int shared = 1;
// WHAM@4 transform 4: guard-close
#endif // WHAM_ONCE_0EC212EC9F2F17D134DF26EB
// WHAM@4 end-transform 4
// WHAM@4 end 1
// WHAM@4 reference 5: src/shared.h -> 1
// #region WHAM recovery
// clang-format off
// WHAM@4 recovery-begin
// {
//   "type": "manifest",
//   "version": 4,
//   "root": "src/mod.cpp",
//   "files": [
//     {
//       "path": "src/mod.cpp",
//       "hash": "fd122cdcdd66a11a0d016d659594bf28962d1a2d1e30d024692e3f0e661d5804",
//       "bom": false
//     },
//     {
//       "path": "src/shared.h",
//       "hash": "07e8e8d68ff4d8f0487386a3e86434bae1f7e13a4dcdc29f3fa6bbf47651e211",
//       "bom": false
//     }
//   ],
//   "config": {
//     "formatVersion": 1,
//     "sourceDirectory": "src",
//     "outputDirectory": "output",
//     "entries": [
//       "mod.cpp"
//     ],
//     "exclude": [],
//     "includeDirectories": [
//       "src"
//     ],
//     "externalIncludes": [],
//     "inlineAngleIncludes": false,
//     "generate": "onSave",
//     "debounceMs": 250
//   },
//   "tail": "",
//   "records": [
//     {
//       "type": "include",
//       "id": 1,
//       "path": "src/shared.h",
//       "directive": "#include \"shared.h\"\r\n"
//     },
//     {
//       "type": "transform",
//       "id": 2,
//       "kind": "pragma-once",
//       "directive": "#pragma once\r\n",
//       "hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
//     },
//     {
//       "type": "transform",
//       "id": 3,
//       "kind": "guard-open",
//       "hash": "23dc3aa04fc3f3e4297883c377db65a7485c209fbb159d17c7dc257bbb5667e2"
//     },
//     {
//       "type": "transform",
//       "id": 4,
//       "kind": "guard-close",
//       "separatorBefore": "\n",
//       "hash": "7a39cae396a475b3c7cd17e68819170523a4119b8b6d8e31a94faa6a2af1dcf1"
//     },
//     {
//       "type": "reference",
//       "id": 5,
//       "path": "src/shared.h",
//       "directive": "#include \"shared.h\"\n",
//       "bodyId": 1
//     }
//   ]
// }
// WHAM@4 recovery-end
// clang-format on
// #endregion
