export interface AugmentPosixPathOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly delimiter?: string;
}

export interface AugmentPosixPathResult {
  readonly changed: boolean;
  readonly path: string;
}

export function augmentPosixPath(options?: AugmentPosixPathOptions): AugmentPosixPathResult;
