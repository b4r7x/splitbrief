export type PathAccess = 'read' | 'list' | 'search' | 'write';

/**
 * One place a tool use reaches: absolute, its `..` taken as the kernel takes it
 * (`resolveFollowingLinks`), with how it is reached. `followsLink` is false where
 * the command acts on the name itself — `rm node_modules` removes the link, it
 * does not reach through it. `mentioned` marks a word only guessed to be a path
 * — an operand of a command this reading does not know, like the test name in
 * `vitest -t /api/users` — which reaches something only if it exists.
 */
export type PathReference = Readonly<{
  path: string;
  access: PathAccess;
  followsLink: boolean;
  mentioned?: boolean | undefined;
  /** The write a package-manager install, ci, add, remove or update makes to `node_modules`. */
  changesPackages?: boolean | undefined;
}>;

/** What `~`, `$HOME`, `$TMPDIR` and a relative path mean for the process that runs the command. */
export type PathScope = Readonly<{ cwd: string; home: string; tmpdir: string | undefined }>;

export type ShellContext = {
  /** The directory the command runs in, shared with the commands after it. */
  state: { cwd: string };
  /**
   * A command that moves the shell and reads where it lands: `cd` keeps the path it was
   * given, as bash and zsh do unless `-P` says otherwise; `git -C` lands where the kernel does.
   */
  chdir: (word: string, how: 'by-name' | 'through-links') => void;
  add: (word: string, access: PathAccess, followsLink?: boolean) => void;
  /** A word that may or may not be a path: an unknown command's operand. */
  mention: (word: string) => void;
  /** A package-manager install, ci, add, remove or update run from `dir`. */
  changesPackages: (dir: string) => void;
  /** Another command line's words, run from here: `xargs rm`, `find -exec`, `sudo cat`. */
  words: (argv: readonly string[]) => void;
  /** A script this one hands to another shell: `bash -c`, `npx -c`. */
  script: (source: string) => void;
};

export type Handler = (args: readonly string[], ctx: ShellContext) => void;

/** What a command line reaches, and the directory its shell is left in for the next one. */
export type ShellReading = Readonly<{ references: PathReference[]; cwd: string }>;
