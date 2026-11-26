import path from 'node:path';
import { portableRelative } from './config';
import { checksum, restoreSource } from './engine';
import type { ModMetadata } from './metadata';
import type { InstallationPreferences } from './preferences';
import type { EditorSettings, gitStatus } from './setup';
import type { Diagnostic, GenerationResult, Project } from './types';
import type { InstalledMod, ParsedModSource, WindhawkInstallation } from './windhawk';

/*
 * Project and mod-entry state shared by the extension's pipelines, and the decisions
 * made from it. Nothing here touches VS Code, so it is unit-tested directly.
 */

/** Output state shown on each mod card. */
export type EntryStatus = 'current' | 'stale' | 'pending' | 'generating' | 'blocked';
export type Operation = 'compile' | 'test' | 'verify' | 'enable' | 'disable';
export type CompileStatus = 'current' | 'uncompiled' | 'unknown';

export interface EntryState {
  path: string;
  output: string;
  status: EntryStatus;
  message?: string;
  metadata?: ModMetadata;
  /** Last generation from saved sources. */
  result?: GenerationResult;
  /** Latest generation including unsaved buffers; used for previews and compile status. */
  draft?: GenerationResult;
  draftConfig?: string;
  draftInvalidated?: boolean;
  parsed?: ParsedModSource;
  parsedHash?: string;
  /** Hash of the output WHAM last wrote, proving it may be replaced. */
  ownedHash?: string;
  installed?: InstalledMod;
  busy?: Operation;
  abort?: AbortController;
  stopping?: boolean;
  buildError?: string;
  compilerDiagnostics?: Diagnostic[];
  /** The runtime view sent to the sidebar. */
  runtime?: {
    id?: string;
    installed: boolean;
    enabled: boolean;
    changesPending: boolean;
    compileStatus?: CompileStatus;
    busy: boolean;
    operation?: Operation;
    stopping?: boolean;
    error?: string;
  };
}

export interface ProjectState {
  project: Project;
  entries: Map<string, EntryState>;
  /** Serializes generation, refreshes and configuration changes for this project. */
  queue: Promise<void>;
  removed?: boolean;
  subscriptions?: { dispose(): unknown }[];
  /** Entries waiting for the generation debounce. */
  pending: Set<string>;
  timer?: NodeJS.Timeout;
  error?: string;
  /** Notices about outputs WHAM kept instead of deleting. */
  retained: string[];
  runtimeTimer?: NodeJS.Timeout;
  runtimePending?: boolean;
  pollInstalled?: boolean;
  /** Entries waiting for the Draft refresh debounce. */
  draftPending: Set<string>;
  windhawk?: WindhawkInstallation & { installationPreferences: InstallationPreferences };
  windhawkStamp?: string;
  editor: EditorSettings & { installationPreferences: InstallationPreferences };
  editorNeedsApply?: boolean;
  git?: Awaited<ReturnType<typeof gitStatus>>;
}

/** Windows paths compare case-insensitively; elsewhere paths are exact. */
export const sameFile = (left: string, right: string) =>
  process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
/** Case-insensitive key for installation-scoped state (Windhawk runs on Windows). */
export const pathKey = (root: string) => path.resolve(root).toLowerCase();
/** One key per installed mod, shared by every project that builds it. */
export const installedModKey = (root: string, id: string | undefined) => JSON.stringify([pathKey(root), id]);
/** Windhawk's ID for a locally compiled mod, or undefined when @id is missing or invalid. */
export const localModId = (id: unknown) =>
  typeof id === 'string' && /^[a-z0-9-]+$/.test(id) ? 'local@' + id : undefined;
/** Compile-snapshot hash; ignores a BOM and line-ending differences. */
export const sourceHash = (source: string) =>
  checksum(Buffer.from(source.replace(/^\uFEFF/, '').replace(/\r\n|\r/g, '\n')));

/** Keep an entry's operation and the runtime view sent to the sidebar in step. */
export function setBusy(entry: EntryState, operation: EntryState['busy']) {
  entry.busy = operation;
  entry.stopping = false;
  if (entry.runtime) {
    entry.runtime.busy = !!operation;
    entry.runtime.operation = operation;
    entry.runtime.stopping = false;
  }
}

/**
 * Whether editing or saving `file` can change this entry: the entry itself, a file its
 * last generation read, or a path it searched for an include that was not found.
 */
export function dependsOn(entry: EntryState, file: string): boolean {
  const generation = entry.draft ?? entry.result;
  return (
    sameFile(entry.path, file) ||
    [...(generation?.dependencies.keys() ?? [])].some(dependency => sameFile(dependency, file)) ||
    (generation?.attempts ?? []).some(attempt => sameFile(attempt, file))
  );
}

/**
 * Whether WHAM may overwrite an existing output: it is what WHAM expects to write, what it
 * last wrote, or an unedited recovery container for this same entry.
 */
export function ownedOutput(existing: Buffer, entry: EntryState, projectRoot: string, expected?: Buffer): boolean {
  if (expected?.equals(existing) || entry.ownedHash === checksum(existing)) return true;
  try {
    const restored = restoreSource(existing);
    return (
      restored.manifest.root === portableRelative(projectRoot, entry.path) &&
      restored.conflicts.length === 0 &&
      [...restored.files.values()].every(candidates => candidates.every(candidate => !candidate.changed))
    );
  } catch {
    return false;
  }
}

/** What WHAM recorded after a successful compile of a source snapshot. */
export interface CompiledSnapshot {
  sourceHash: string;
  libraryFileName: string;
}

/**
 * Whether the installed build came from the current Draft. Saved source is editable
 * without compiling; only a successful build links a snapshot to Windhawk's library name.
 */
export function compileStatus(entry: EntryState, build: CompiledSnapshot | undefined): CompileStatus {
  if (!entry.installed) return 'unknown';
  if (!entry.installed.config) return 'uncompiled';
  const library = entry.installed.config.libraryFileName;
  if (!build || !library || build.libraryFileName !== library) return 'unknown';
  if (!entry.draft?.bytes || sourceHash(entry.draft.bytes.toString()) !== build.sourceHash) return 'uncompiled';
  return 'current';
}

/** Status bar summary for the active project's entries. */
export function projectSummary(state: ProjectState | undefined): string {
  if (state?.error) return 'configuration error';
  const statuses = state ? [...state.entries.values()].map(entry => entry.status) : [];
  if (statuses.includes('generating')) return 'generating';
  if (statuses.includes('blocked')) return 'output edits';
  return statuses.some(value => value !== 'current') ? 'stale' : 'current';
}
