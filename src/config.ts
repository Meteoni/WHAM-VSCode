import path from 'node:path';
import { minimatch } from 'minimatch';
import { Configuration, FileAccess, Project } from './types';

export const defaults: Configuration = {
  formatVersion: 1, sourceDirectory: 'src', outputDirectory: 'output',
  entries: ['**/*.cpp'], exclude: [], includeDirectories: ['src'], externalIncludes: [],
  inlineAngleIncludes: false, generate: 'onSave', debounceMs: 250
};

/** Reject nonportable paths before either generation or restoration uses them. */
export function portablePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') ||
      value.split('/').some(part => !part || part === '.' || part === '..' ||
        /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Invalid portable relative path: ${String(value)}`);
  }
  return value;
}

export function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateConfig(input: unknown): Configuration {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be a JSON object.');
  const config = { ...defaults, ...input } as Configuration;
  const allowed = new Set(Object.keys(defaults));
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unknown configuration field: ${key}`);
  if (config.formatVersion !== 1) throw new Error('Unsupported configuration formatVersion.');
  portablePath(config.sourceDirectory); portablePath(config.outputDirectory);
  const source = config.sourceDirectory.toLowerCase(), output = config.outputDirectory.toLowerCase();
  if (source === output || source.startsWith(output + '/') || output.startsWith(source + '/')) throw new Error('Source and output directories must not overlap.');
  for (const key of ['entries', 'exclude', 'includeDirectories', 'externalIncludes'] as const) {
    if (!Array.isArray(config[key]) || config[key].some(value => typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value))) throw new Error(`${key} must be an array of nonempty strings.`);
  }
  for (const directory of config.includeDirectories) portablePath(directory);
  for (const glob of [...config.entries, ...config.exclude]) {
    if (glob.startsWith('/') || glob.includes('\\') || glob.split('/').includes('..') || glob.includes(':')) throw new Error(`Invalid entry glob: ${glob}`);
  }
  if (typeof config.inlineAngleIncludes !== 'boolean' || !['manual', 'onSave'].includes(config.generate)) throw new Error('Invalid generation settings.');
  if (!Number.isInteger(config.debounceMs) || config.debounceMs < 0 || config.debounceMs > 10000) throw new Error('debounceMs must be an integer from 0 to 10000.');
  return config;
}

export async function discoverEntries(project: Project, files: FileAccess): Promise<string[]> {
  const source = path.resolve(project.root, project.config.sourceDirectory);
  const entries = (await files.list(source)).filter(file => {
    const relative = path.relative(source, file).split(path.sep).join('/');
    return /\.cpp$/i.test(relative) && project.config.entries.some(glob => minimatch(relative, glob, { dot: true })) &&
      !project.config.exclude.some(glob => minimatch(relative, glob, { dot: true }));
  }).sort();
  const outputs = new Map<string, string>();
  for (const entry of entries) {
    const output = outputPath(project, entry).toLowerCase();
    if (outputs.has(output)) throw new Error(`Output collision: ${outputs.get(output)} and ${entry}`);
    outputs.set(output, entry);
  }
  return entries;
}

export function outputPath(project: Project, entry: string): string {
  const source = path.resolve(project.root, project.config.sourceDirectory);
  if (!contained(source, entry)) throw new Error('Entry is outside the source directory.');
  const relative = path.relative(source, entry).replace(/(?:\.wh)?\.cpp$/i, '.wh.cpp');
  return path.resolve(project.root, project.config.outputDirectory, relative);
}
