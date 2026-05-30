const {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} = require("node:fs");
const { dirname, isAbsolute, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");

type Fields = Record<string, unknown>;

const root = process.cwd();
const artifactRoot = join(root, "target", "ci-artifacts");
const configuredTrace = process.env.NANOGRAPH_CI_TRACE;
const tracePath = configuredTrace === undefined || configuredTrace.trim() === ""
  ? join(artifactRoot, "windows-artifacts-trace.jsonl")
  : isAbsolute(configuredTrace)
    ? configuredTrace
    : join(root, configuredTrace);

mkdirSync(artifactRoot, { recursive: true });
mkdirSync(dirname(tracePath), { recursive: true });

function log(event: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    event,
    time: new Date().toISOString(),
    ...fields
  });
  appendFileSync(tracePath, `${line}\n`);
  console.log(line);
}

function commandName(name: string): string {
  return name;
}

function run(
  phase: string,
  expected: string,
  hypothesis: string,
  cwd: string,
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): void {
  const started = Date.now();
  log("phase-start", {
    phase,
    expected,
    hypothesis,
    cwd,
    command: [command, ...args].join(" ")
  });

  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    shell: process.platform === "win32" && (command === "npm" || command === "npx"),
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const fields = {
    phase,
    elapsedMs: Date.now() - started,
    exitCode: result.status,
    signal: result.signal,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr)
  };

  if (result.status === 0) {
    log("phase-end", fields);
    return;
  }

  log("phase-error", {
    ...fields,
    expected,
    hypothesis,
    spawnError: result.error?.message
  });
  process.exit(result.status ?? 1);
}

function tail(text: string | null | undefined): string {
  if (!text) {
    return "";
  }
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - 40)).join("\n");
}

function requireFile(phase: string, path: string): void {
  if (existsSync(path)) {
    return;
  }
  log("phase-error", {
    phase,
    expected: "required artifact exists",
    hypothesis: "build output path changed or previous phase failed before producing the file",
    path
  });
  process.exit(1);
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function writeSha256(path: string, fileName: string): string {
  const shaPath = `${path}.sha256`;
  writeFileSync(shaPath, `${sha256File(path)}  ${fileName}`);
  return shaPath;
}

function copyArtifact(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

const tsDir = join(root, "crates", "nanograph-ts");
const cliExe = join(root, "target", "release", "nanograph.exe");
const tsBinding = join(tsDir, "nanograph.win32-x64-msvc.node");

function recordEnvironment(): void {
  log("environment", {
    root,
    tracePath,
    cargoCacheHit: process.env.CARGO_CACHE_HIT,
    npmCacheHit: process.env.NPM_CACHE_HIT,
    githubRef: process.env.GITHUB_REF,
    githubSha: process.env.GITHUB_SHA,
    runnerOs: process.env.RUNNER_OS
  });
  run("rust.version", "rust toolchain is installed", "toolchain install step did not run or PATH is broken", root, "rustc", ["--version"]);
  run("cargo.version", "cargo is available", "toolchain install step did not run or PATH is broken", root, "cargo", ["+1.94.1", "--version"]);
  run("node.version", "node is available", "actions/setup-node did not install the requested Node version", root, "node", ["--version"]);
}

function installNpm(): void {
  run("npm.install", "npm dependencies install without running package scripts", "package-lock drift or npm cache corruption", tsDir, commandName("npm"), ["install", "--ignore-scripts"]);
}

function buildCliRelease(): void {
  run("build.cli.release", "release CLI builds successfully", "Rust dependency, upstream merge, or Windows linker failure", root, "cargo", ["+1.94.1", "build", "-p", "nanograph-cli", "--release", "--locked"]);
}

function packageCliRelease(): void {
  const phase = "package.cli.release";
  requireFile(phase, cliExe);
  run("verify.cli.release", "release CLI starts and prints a version", "binary exists but runtime initialization fails", root, cliExe, ["--version"]);
  const outputDir = join(artifactRoot, "nanograph-windows-x64-cli-release");
  const outputExe = join(outputDir, "nanograph.exe");
  copyArtifact(cliExe, outputExe);
  const shaPath = writeSha256(outputExe, "nanograph.exe");
  log("phase-end", {
    phase,
    expected: "release CLI and checksum are downloadable",
    artifactDir: outputDir,
    exe: outputExe,
    sha256: shaPath
  });
}

function buildTs(profile: "debug" | "release"): void {
  const releaseArgs = profile === "release" ? ["--release"] : [];
  const traceEnv = profile === "debug"
    ? {
        RUST_BACKTRACE: "full",
        RUST_LOG: "trace",
        NANOGRAPH_TRACE: "1",
        NAPI_RS_LOG: "debug"
      }
    : {};
  run(
    `build.ts.${profile}`,
    `${profile} TS native binding builds successfully`,
    "napi build, Rust dependency, or Lance Windows build failure",
    tsDir,
    commandName("npx"),
    ["napi", "build", "--platform", "--js", "index.js", ...releaseArgs, "--target", "x86_64-pc-windows-msvc"],
    traceEnv
  );
}

function packageTs(profile: "debug" | "release"): void {
  const phase = `package.ts.${profile}`;
  requireFile(phase, tsBinding);
  run(
    `verify.ts.${profile}`,
    `${profile} TS binding exports Database`,
    "native module loads but napi exports are broken",
    tsDir,
    "node",
    ["-e", "const ng=require('.'); if (typeof ng.Database !== 'function') throw new Error('Database export missing'); console.log(typeof ng.Database)"]
  );

  const artifactName = profile === "release"
    ? "nanograph-ts-win32-x64-msvc-node-release"
    : "nanograph-ts-win32-x64-msvc-node-debug";
  const outputDir = join(artifactRoot, artifactName);
  const outputFileName = profile === "release"
    ? "nanograph.win32-x64-msvc.node"
    : "nanograph.win32-x64-msvc.debug.node";
  const outputBinding = join(outputDir, outputFileName);
  copyArtifact(tsBinding, outputBinding);
  const shaPath = writeSha256(outputBinding, outputFileName);
  log("phase-end", {
    phase,
    expected: `${profile} TS binding and checksum are downloadable`,
    artifactDir: outputDir,
    binding: outputBinding,
    sha256: shaPath
  });
}

function all(): void {
  recordEnvironment();
  installNpm();
  buildCliRelease();
  packageCliRelease();
  buildTs("debug");
  packageTs("debug");
  buildTs("release");
  packageTs("release");
  log("done", {
    expected: "release artifacts are usable and debug diagnostics are available",
    hypothesis: "if this point is reached, remaining Lance slowdown must be measured with the repro binary",
    artifactRoot
  });
}

const command = process.argv[2] ?? "all";
switch (command) {
  case "all":
    all();
    break;
  case "record-env":
    recordEnvironment();
    break;
  case "install-npm":
    installNpm();
    break;
  case "build-cli-release":
    buildCliRelease();
    break;
  case "package-cli-release":
    packageCliRelease();
    break;
  case "build-ts-debug":
    buildTs("debug");
    break;
  case "package-ts-debug":
    packageTs("debug");
    break;
  case "build-ts-release":
    buildTs("release");
    break;
  case "package-ts-release":
    packageTs("release");
    break;
  default:
    throw new Error(`unknown command: ${command}`);
}
