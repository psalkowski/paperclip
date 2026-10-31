import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sink = vi.hoisted(() => ({ delayMs: 0 }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { Writable } = await import("node:stream");
  const createWriteStream = ((...args: Parameters<typeof actual.createWriteStream>) => {
    const file = actual.createWriteStream(...args);
    if (sink.delayMs === 0) return file;
    return new Writable({
      highWaterMark: 1024,
      write(chunk, _encoding, callback) {
        setTimeout(() => file.write(chunk, callback), sink.delayMs);
      },
      final(callback) {
        file.end(callback);
      },
      destroy(error, callback) {
        file.destroy(error ?? undefined);
        callback(error);
      },
    });
  }) as typeof actual.createWriteStream;
  return { ...actual, default: { ...actual, createWriteStream }, createWriteStream };
});

import { restoreWorkspaceFromSshExecution } from "./ssh.js";

const FAKE_SSH = `#!/bin/sh
for arg; do command=$arg; done
export HOME="$FAKE_SSH_HOME"
case $command in
  *export-XXXXXX.bundle*)
    remaining=$(cat "$FAKE_SSH_TRUNCATED_EXPORTS")
    if [ "$remaining" -gt 0 ]; then
      echo $((remaining - 1)) > "$FAKE_SSH_TRUNCATED_EXPORTS"
      out=$(mktemp)
      /bin/sh -c "$command" > "$out"
      status=$?
      head -c $(($(wc -c < "$out") - 11520)) "$out"
      rm -f "$out"
      exit $status
    fi
    ;;
esac
exec /bin/sh -c "$command"
`;

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@paperclip.dev", "-c", "commit.gpgsign=false", ...args], (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || stdout || error.message).trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

describe("git history export from ssh", () => {
  let rootDir: string;
  let localRepo: string;
  let remoteRepo: string;
  let remoteHead: string;
  let truncatedExports: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-git-export-"));
    const binDir = path.join(rootDir, "bin");
    await mkdir(binDir);
    await writeFile(path.join(binDir, "ssh"), FAKE_SSH);
    await chmod(path.join(binDir, "ssh"), 0o755);
    truncatedExports = path.join(rootDir, "truncated-exports");
    await writeFile(truncatedExports, "0\n");
    vi.stubEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`);
    vi.stubEnv("FAKE_SSH_HOME", rootDir);
    vi.stubEnv("FAKE_SSH_TRUNCATED_EXPORTS", truncatedExports);

    localRepo = path.join(rootDir, "local");
    remoteRepo = path.join(rootDir, "remote");
    await mkdir(localRepo);
    await git(localRepo, ["init", "-b", "main"]);
    await writeFile(path.join(localRepo, "base.txt"), "base\n");
    await git(localRepo, ["add", "."]);
    await git(localRepo, ["commit", "-m", "base"]);
    await git(rootDir, ["clone", "-q", localRepo, remoteRepo]);
    await writeFile(path.join(remoteRepo, "work.bin"), randomBytes(3 * 1024 * 1024));
    await git(remoteRepo, ["add", "."]);
    await git(remoteRepo, ["commit", "-m", "remote work"]);
    remoteHead = await git(remoteRepo, ["rev-parse", "HEAD"]);
  });

  afterEach(async () => {
    sink.delayMs = 0;
    vi.unstubAllEnvs();
    await rm(rootDir, { recursive: true, force: true });
  });

  function restore(progress: string[]) {
    return restoreWorkspaceFromSshExecution({
      spec: {
        host: "agent-host",
        port: 22,
        username: "agent",
        remoteWorkspacePath: remoteRepo,
        remoteCwd: remoteRepo,
        privateKey: null,
        knownHosts: null,
        strictHostKeyChecking: false,
      },
      localDir: localRepo,
      remoteDir: remoteRepo,
      onProgress: (line) => {
        progress.push(line);
      },
    });
  }

  it("keeps the whole bundle when the local file is written slower than ssh delivers it", async () => {
    sink.delayMs = 20;

    await restore([]);

    expect(await git(localRepo, ["rev-parse", "HEAD"])).toBe(remoteHead);
  }, 60_000);

  it("transfers the bundle again when it arrives truncated", async () => {
    await writeFile(truncatedExports, "1\n");
    const progress: string[] = [];

    await restore(progress);

    expect(await git(localRepo, ["rev-parse", "HEAD"])).toBe(remoteHead);
    expect(progress.join("")).toMatch(/Exporting git history from ssh failed \(attempt 1 of 3\)/);
    expect((await readFile(truncatedExports, "utf8")).trim()).toBe("0");
  }, 60_000);

  it("fails with the received and expected sizes when every transfer arrives truncated", async () => {
    await writeFile(truncatedExports, "5\n");

    await expect(restore([])).rejects.toThrow(/received \d+ of \d+ bundle bytes/);
    expect((await readFile(truncatedExports, "utf8")).trim()).toBe("2");
  }, 60_000);
});
