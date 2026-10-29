export interface Configuration {
  formatVersion: 1;
  sourceDirectory: string;
  outputDirectory: string;
  entries: string[];
  exclude: string[];
  includeDirectories: string[];
  externalIncludes: string[];
  inlineAngleIncludes: boolean;
  generate: 'onSave' | 'manual';
  debounceMs: number;
}
export interface FileAccess {
  read(path: string): Promise<Buffer>;
  identity(path: string): Promise<string>;
  list(directory: string): Promise<string[]>;
}
export interface Project { root: string; config: Configuration }
export interface Diagnostic { path: string; line: number; message: string; severity: 'error' | 'warning' }
export interface GenerationResult {
  bytes?: Buffer;
  dependencies: Map<string, string>;
  attempts: string[];
  spans: { path: string; sourceLine: number; outputStart: number; outputEnd: number }[];
  diagnostics: Diagnostic[];
}
export interface FileRecord { path: string; hash: string; bom: boolean }
export interface RecoveryData {
  type: 'include' | 'reference' | 'fragment' | 'transform'; id: number; path?: string; kind?: string; bodyId?: number; guard?: string; lines?: number;
  directive?: string; separatorBefore?: string; separatorAfter?: string; hash?: string;
}
export interface Manifest {
  type: 'manifest'; version: 1 | 2 | 3 | 4 | 5; root: string; files: FileRecord[]; records?: RecoveryData[];
  config: Configuration; tail: string;
}
export interface RestoreCandidate { bytes: Buffer; occurrences: number[]; changed: boolean }
export interface RestoreResult {
  manifest: Manifest;
  files: Map<string, RestoreCandidate[]>;
  conflicts: string[];
}
