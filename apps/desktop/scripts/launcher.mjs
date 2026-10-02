import crossSpawn from "cross-spawn";

/**
 * Spawn a child process the way the dev launcher needs on every platform.
 *
 * `cross-spawn` resolves Windows `.cmd`/`.exe` shims (such as `pnpm`) so
 * commands launch without `spawn ENOENT`, and it forwards argv verbatim. Unlike
 * `spawn(cmd, args, { shell: true })` it does NOT route through a shell, so
 * arguments are never re-split/re-interpreted and Node's `DEP0190` deprecation
 * warning (spawn with `{ shell: true }` and an args array) is never emitted.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import("node:child_process").SpawnOptions} [options]
 * @returns {import("node:child_process").ChildProcess}
 */
export function spawnProcess(command, args, options) {
  return crossSpawn(command, args, options);
}

/**
 * Run a command to completion, rejecting on a non-zero exit.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {Promise<void>}
 */
export function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} exited with ${signal ?? code}`));
    });
  });
}

/**
 * Start a long-lived command, returning the child process.
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {string} cwd
 * @returns {import("node:child_process").ChildProcess}
 */
export function start(command, args, cwd) {
  return spawnProcess(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
}
