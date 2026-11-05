export declare function ensureOpenClawExtensionAlias(params: {
  distExtensionsRoot: string;
  repoRoot: string;
  aliasDir?: string;
}): void;

export declare function writeRuntimeModuleWrapper(
  sourcePath: string,
  targetPath: string,
  finalPath?: string,
): void;
