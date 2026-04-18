/**
 * Runtime-agnostic code-review core shared by Bun runtimes and Pi.
 *
 * Pi consumes a build-time copy of this file so its published package stays
 * self-contained while review diff logic remains sourced from one module.
 */

import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

export type StackDiffType = `stack:${string}`;

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch"
  | "merge-base"
  | StackDiffType
  | `worktree:${string}`
  | "p4-default"
  | `p4-changelist:${string}`;

export interface DiffOption {
  id: string;
  label: string;
  group?: string;
  disabled?: boolean;
  trainName?: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export interface GitStackTrainChoice {
  name: string;
  label: string;
}

export interface GitStackContext {
  trains: GitStackTrainChoice[];
  selectedTrain: string | null;
  currentBranchTrain: string | null;
  showTrainSelector: boolean;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
  worktrees: WorktreeInfo[];
  cwd?: string;
  vcsType?: "git" | "p4";
  stackContext?: GitStackContext;
}

export interface DiffResult {
  patch: string;
  label: string;
  error?: string;
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ReviewGitRuntime {
  runGit: (
    args: string[],
    options?: { cwd?: string },
  ) => Promise<GitCommandResult>;
  readTextFile: (path: string) => Promise<string | null>;
}

interface GitStackBranchDefinition {
  name: string;
  role: "normal" | "combined";
}

interface GitStackTrainDefinition {
  name: string;
  syncBase: string;
  prTarget: string;
  branches: GitStackBranchDefinition[];
}

interface GitStackConfig {
  remote: string;
  trains: GitStackTrainDefinition[];
}

interface StackBranchDiffOption {
  branchName: string;
  role: "normal" | "combined";
  baseBranch: string;
  headRef: string | null;
  baseRef: string | null;
  diffType: StackDiffType;
  label: string;
  disabled: boolean;
  isCurrent: boolean;
}

interface GetGitContextOptions {
  selectedTrainName?: string | null;
}

interface StackDiffPayload {
  trainName: string;
  baseRef: string;
  headRef: string;
  label: string;
}

const WORKTREE_SUB_TYPES = new Set([
  "uncommitted",
  "staged",
  "unstaged",
  "last-commit",
  "branch",
  "merge-base",
]);

function parseScalarValue(rawValue: string): string | boolean | null {
  const value = rawValue.trim();
  if (!value.length) {
    return "";
  }

  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (value === "null") {
    return null;
  }

  return value;
}

function splitIndent(line: string): { indent: number; trimmed: string } {
  const indent = line.match(/^ */)?.[0].length ?? 0;
  return { indent, trimmed: line.trim() };
}

function parseGitStackConfig(text: string): GitStackConfig | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const trains: GitStackTrainDefinition[] = [];
  let remote = "origin";
  let section: "defaults" | "trains" | null = null;
  let currentTrain: GitStackTrainDefinition | null = null;
  let inBranches = false;
  let pendingBranch: Partial<GitStackBranchDefinition> | null = null;

  function flushPendingBranch(): void {
    if (!currentTrain || !pendingBranch?.name) {
      pendingBranch = null;
      return;
    }

    currentTrain.branches.push({
      name: pendingBranch.name,
      role: pendingBranch.role === "combined" ? "combined" : "normal",
    });
    pendingBranch = null;
  }

  for (const rawLine of lines) {
    const { indent, trimmed } = splitIndent(rawLine);
    if (!trimmed.length || trimmed.startsWith("#")) {
      continue;
    }

    if (indent === 0) {
      flushPendingBranch();
      currentTrain = null;
      inBranches = false;

      if (trimmed === "defaults:") {
        section = "defaults";
        continue;
      }

      if (trimmed === "stacks:" || trimmed === "trains:") {
        section = "trains";
        continue;
      }

      section = null;
      continue;
    }

    if (section === "defaults") {
      if (indent === 2 && trimmed === "remote:") {
        remote = "origin";
        continue;
      }

      if (indent === 2 && trimmed.startsWith("remote:")) {
        const parsed = parseScalarValue(trimmed.slice("remote:".length));
        if (typeof parsed === "string" && parsed.length) {
          remote = parsed;
        }
      }
      continue;
    }

    if (section !== "trains") {
      continue;
    }

    if (indent === 2 && trimmed.endsWith(":")) {
      flushPendingBranch();
      const name = trimmed.slice(0, -1);
      currentTrain = {
        name,
        syncBase: "main",
        prTarget: "main",
        branches: [],
      };
      trains.push(currentTrain);
      inBranches = false;
      continue;
    }

    if (!currentTrain) {
      continue;
    }

    if (indent === 4) {
      flushPendingBranch();
      inBranches = false;

      if (trimmed.startsWith("syncBase:")) {
        const parsed = parseScalarValue(trimmed.slice("syncBase:".length));
        if (typeof parsed === "string" && parsed.length) {
          currentTrain.syncBase = parsed;
        }
        continue;
      }

      if (trimmed.startsWith("prTarget:")) {
        const parsed = parseScalarValue(trimmed.slice("prTarget:".length));
        if (typeof parsed === "string" && parsed.length) {
          currentTrain.prTarget = parsed;
        }
        continue;
      }

      if (trimmed === "branches:") {
        inBranches = true;
      }
      continue;
    }

    if (!inBranches) {
      continue;
    }

    if (indent === 6 && trimmed.startsWith("- ")) {
      flushPendingBranch();
      const branchValue = trimmed.slice(2).trim();
      if (!branchValue.length) {
        pendingBranch = {};
        continue;
      }

      if (branchValue.startsWith("name:")) {
        const parsed = parseScalarValue(branchValue.slice("name:".length));
        pendingBranch = {
          name: typeof parsed === "string" ? parsed : undefined,
          role: "normal",
        };
        continue;
      }

      const parsed = parseScalarValue(branchValue);
      if (typeof parsed === "string" && parsed.length) {
        currentTrain.branches.push({
          name: parsed,
          role: "normal",
        });
      }
      continue;
    }

    if (indent === 8 && pendingBranch) {
      if (trimmed.startsWith("name:")) {
        const parsed = parseScalarValue(trimmed.slice("name:".length));
        if (typeof parsed === "string" && parsed.length) {
          pendingBranch.name = parsed;
        }
      }

      if (trimmed.startsWith("role:")) {
        const parsed = parseScalarValue(trimmed.slice("role:".length));
        if (parsed === "combined") {
          pendingBranch.role = "combined";
        }
        if (parsed === "normal") {
          pendingBranch.role = "normal";
        }
      }
    }
  }

  flushPendingBranch();

  if (!trains.length) {
    return null;
  }

  return { remote, trains };
}

async function loadGitStackConfig(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<GitStackConfig | null> {
  const repoRootResult = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
  const repoRoot = repoRootResult.exitCode === 0 ? repoRootResult.stdout.trim() : null;

  const homePath = process.env.HOME || homedir();
  const globalPath = join(homePath, ".config", "git-stack", "stacks.yml");
  const localPath = repoRoot ? join(repoRoot, ".stack.yml") : null;
  const configPaths = [globalPath];
  if (localPath) {
    configPaths.push(localPath);
  }

  for (const configPath of configPaths) {
    const content = await runtime.readTextFile(configPath);
    if (!content) {
      continue;
    }

    const parsed = parseGitStackConfig(content);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function shortBranchName(branchName: string): string {
  const parts = branchName.split("/");
  const short = parts.at(-1);
  if (short && short.length) {
    return short;
  }
  return branchName;
}

async function refExists(
  runtime: ReviewGitRuntime,
  ref: string,
  cwd?: string,
): Promise<boolean> {
  const result = await runtime.runGit(["show-ref", "--verify", "--quiet", ref], { cwd });
  return result.exitCode === 0;
}

async function resolveBranchRef(
  runtime: ReviewGitRuntime,
  branchName: string,
  remote: string,
  cwd?: string,
): Promise<string | null> {
  if (await refExists(runtime, `refs/heads/${branchName}`, cwd)) {
    return branchName;
  }

  if (await refExists(runtime, `refs/remotes/${remote}/${branchName}`, cwd)) {
    return `${remote}/${branchName}`;
  }

  return null;
}

async function isMergedIntoTarget(
  runtime: ReviewGitRuntime,
  branchRef: string | null,
  targetRef: string | null,
  cwd?: string,
): Promise<boolean> {
  if (!branchRef || !targetRef) {
    return false;
  }

  const result = await runtime.runGit(
    ["merge-base", "--is-ancestor", branchRef, targetRef],
    { cwd },
  );
  return result.exitCode === 0;
}

function createStackDiffType(payload: StackDiffPayload): StackDiffType {
  const encodedParts = [
    payload.trainName,
    payload.baseRef,
    payload.headRef,
    payload.label,
  ].map((part) => encodeURIComponent(part));
  return `stack:${encodedParts.join("|")}` as StackDiffType;
}

export function parseStackDiffType(diffType: string): StackDiffPayload | null {
  if (!diffType.startsWith("stack:")) {
    return null;
  }

  const encodedParts = diffType.slice("stack:".length).split("|");
  if (encodedParts.length !== 4) {
    return null;
  }

  const [trainName, baseRef, headRef, label] = encodedParts.map((part) =>
    decodeURIComponent(part),
  );
  return { trainName, baseRef, headRef, label };
}

export function createWorktreeDiffType(path: string, subType: string): DiffType {
  const encodedPath = encodeURIComponent(path);
  const encodedSubType = encodeURIComponent(subType);
  return `worktree:${encodedPath}::${encodedSubType}` as DiffType;
}

export function parseWorktreeDiffType(
  diffType: string,
): { path: string; subType: string } | null {
  if (!diffType.startsWith("worktree:")) {
    return null;
  }

  const rest = diffType.slice("worktree:".length);
  const separator = rest.indexOf("::");
  if (separator !== -1) {
    const encodedPath = rest.slice(0, separator);
    const encodedSubType = rest.slice(separator + 2);
    return {
      path: decodeURIComponent(encodedPath),
      subType: decodeURIComponent(encodedSubType),
    };
  }

  const lastColon = rest.lastIndexOf(":");
  if (lastColon !== -1) {
    const maybeSub = rest.slice(lastColon + 1);
    if (WORKTREE_SUB_TYPES.has(maybeSub)) {
      return { path: rest.slice(0, lastColon), subType: maybeSub };
    }
  }

  return { path: rest, subType: "uncommitted" };
}

async function buildStackBranchDiffOptions(
  runtime: ReviewGitRuntime,
  train: GitStackTrainDefinition,
  currentBranch: string,
  remote: string,
  cwd?: string,
): Promise<StackBranchDiffOption[]> {
  const targetRef = await resolveBranchRef(runtime, train.prTarget, remote, cwd);

  const branchStatuses = await Promise.all(
    train.branches.map(async (branch) => {
      const headRef = await resolveBranchRef(runtime, branch.name, remote, cwd);
      const merged = await isMergedIntoTarget(runtime, headRef, targetRef, cwd);
      return {
        ...branch,
        headRef,
        merged,
      };
    }),
  );

  const activeBranches = branchStatuses.filter((branch) => !branch.merged);
  const options: StackBranchDiffOption[] = [];
  let previousNormalBranchName: string | null = null;

  for (const branch of activeBranches) {
    let baseBranch = train.prTarget;
    if (branch.role !== "combined" && previousNormalBranchName) {
      baseBranch = previousNormalBranchName;
    }

    const baseRef = await resolveBranchRef(runtime, baseBranch, remote, cwd);
    const currentLabelParts = [`${shortBranchName(branch.name)} vs ${shortBranchName(baseBranch)}`];
    if (branch.role === "combined") {
      currentLabelParts.push("(combined)");
    }
    if (branch.name === currentBranch) {
      currentLabelParts.push("(current)");
    }
    const label = currentLabelParts.join(" ");
    const disabled = !branch.headRef || !baseRef;
    const diffType = createStackDiffType({
      trainName: train.name,
      baseRef: baseRef ?? baseBranch,
      headRef: branch.headRef ?? branch.name,
      label,
    });

    options.push({
      branchName: branch.name,
      role: branch.role,
      baseBranch,
      headRef: branch.headRef,
      baseRef,
      diffType,
      label,
      disabled,
      isCurrent: branch.name === currentBranch,
    });

    if (branch.role !== "combined") {
      previousNormalBranchName = branch.name;
    }
  }

  return options;
}

function resolveSelectedTrainName(
  trains: GitStackTrainDefinition[],
  currentBranchTrain: string | null,
  requestedTrainName: string | null | undefined,
): string | null {
  if (currentBranchTrain) {
    return currentBranchTrain;
  }

  if (requestedTrainName) {
    const requestedTrain = trains.find((train) => train.name === requestedTrainName);
    if (requestedTrain) {
      return requestedTrain.name;
    }
  }

  if (trains.length === 1) {
    return trains[0]?.name ?? null;
  }

  return null;
}

export async function getCurrentBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const result = await runtime.runGit(
    ["rev-parse", "--abbrev-ref", "HEAD"],
    { cwd },
  );
  return result.exitCode === 0 ? result.stdout.trim() || "HEAD" : "HEAD";
}

export async function getDefaultBranch(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<string> {
  const remoteHead = await runtime.runGit(
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd },
  );
  if (remoteHead.exitCode === 0) {
    const ref = remoteHead.stdout.trim();
    if (ref) {
      return ref.replace("refs/remotes/origin/", "");
    }
  }

  const mainBranch = await runtime.runGit(
    ["show-ref", "--verify", "refs/heads/main"],
    { cwd },
  );
  if (mainBranch.exitCode === 0) {
    return "main";
  }

  return "master";
}

export async function getWorktrees(
  runtime: ReviewGitRuntime,
  cwd?: string,
): Promise<WorktreeInfo[]> {
  const result = await runtime.runGit(["worktree", "list", "--porcelain"], { cwd });
  if (result.exitCode !== 0) {
    return [];
  }

  const entries: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        entries.push({
          path: current.path,
          head: current.head || "",
          branch: current.branch ?? null,
        });
      }
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line
        .slice("branch ".length)
        .replace("refs/heads/", "");
    } else if (line === "detached") {
      current.branch = null;
    }
  }

  if (current.path) {
    entries.push({
      path: current.path,
      head: current.head || "",
      branch: current.branch ?? null,
    });
  }

  return entries;
}

export async function getGitContext(
  runtime: ReviewGitRuntime,
  cwd?: string,
  options?: GetGitContextOptions,
): Promise<GitContext> {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(runtime, cwd),
    getDefaultBranch(runtime, cwd),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "staged", label: "Staged changes" },
    { id: "unstaged", label: "Unstaged changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  const [worktrees, currentTreePathResult, stackConfig] = await Promise.all([
    getWorktrees(runtime, cwd),
    runtime.runGit(["rev-parse", "--show-toplevel"], { cwd }),
    loadGitStackConfig(runtime, cwd),
  ]);

  const currentTreePath =
    currentTreePathResult.exitCode === 0
      ? currentTreePathResult.stdout.trim()
      : null;

  let stackContext: GitStackContext | undefined;
  if (stackConfig && stackConfig.trains.length > 0) {
    const currentBranchTrain =
      stackConfig.trains.find((train) =>
        train.branches.some((branch) => branch.name === currentBranch),
      )?.name ?? null;
    const selectedTrain = resolveSelectedTrainName(
      stackConfig.trains,
      currentBranchTrain,
      options?.selectedTrainName,
    );
    const showTrainSelector =
      stackConfig.trains.length > 1 && currentBranchTrain === null;

    stackContext = {
      trains: stackConfig.trains.map((train) => ({
        name: train.name,
        label: train.name,
      })),
      selectedTrain,
      currentBranchTrain,
      showTrainSelector,
    };

    const selectedTrainDefinition = selectedTrain
      ? stackConfig.trains.find((train) => train.name === selectedTrain) ?? null
      : null;

    let currentPrDiffOption: DiffOption | null = null;
    if (selectedTrainDefinition) {
      const stackBranchOptions = await buildStackBranchDiffOptions(
        runtime,
        selectedTrainDefinition,
        currentBranch,
        stackConfig.remote,
        cwd,
      );

      if (currentBranch !== defaultBranch) {
        const currentBranchOption =
          stackBranchOptions.find((option) => option.branchName === currentBranch) ??
          null;
        if (currentBranchOption) {
          currentPrDiffOption = {
            id: currentBranchOption.diffType,
            label: "Current PR Diff",
            disabled: currentBranchOption.disabled,
            trainName: selectedTrainDefinition.name,
          };
        }
      }

      if (stackBranchOptions.length > 0) {
        diffOptions.push(
          ...stackBranchOptions.map((option) => ({
            id: option.diffType,
            label: option.disabled ? `${option.label} (missing ref)` : option.label,
            group: `Stack: ${selectedTrainDefinition.name}`,
            disabled: option.disabled,
            trainName: selectedTrainDefinition.name,
          })),
        );
      }
    }

    if (currentBranch !== defaultBranch) {
      if (currentPrDiffOption) {
        diffOptions.push(currentPrDiffOption);
      } else {
        diffOptions.push({ id: "merge-base", label: "Current PR Diff" });
      }
    }
  } else if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "merge-base", label: "Current PR Diff" });
  }

  return {
    currentBranch,
    defaultBranch,
    diffOptions,
    worktrees: worktrees.filter((wt) => wt.path !== currentTreePath),
    cwd,
    stackContext,
  };
}

async function getUntrackedFileDiffs(
  runtime: ReviewGitRuntime,
  srcPrefix = "a/",
  dstPrefix = "b/",
  cwd?: string,
): Promise<string> {
  // git ls-files scopes to the CWD subtree and returns CWD-relative paths,
  // unlike git diff HEAD which always covers the full repo with root-relative
  // paths. Resolve the repo root so untracked files from the entire repo are
  // included and their paths match the tracked-diff output.
  const toplevelResult = await runtime.runGit(
    ["rev-parse", "--show-toplevel"],
    { cwd },
  );
  const rootCwd =
    toplevelResult.exitCode === 0 ? toplevelResult.stdout.trim() : cwd;

  const lsResult = await runtime.runGit(
    ["ls-files", "--others", "--exclude-standard"],
    { cwd: rootCwd },
  );
  if (lsResult.exitCode !== 0) {
    return "";
  }

  const files = lsResult.stdout
    .trim()
    .split("\n")
    .filter((file) => file.length > 0);

  if (files.length === 0) {
    return "";
  }

  const diffs = await Promise.all(
    files.map(async (file) => {
      const diffResult = await runtime.runGit(
        [
          "diff",
          "--no-ext-diff",
          "--no-index",
          `--src-prefix=${srcPrefix}`,
          `--dst-prefix=${dstPrefix}`,
          "/dev/null",
          file,
        ],
        { cwd: rootCwd },
      );
      return diffResult.stdout;
    }),
  );

  return diffs.join("");
}

function assertGitSuccess(
  result: GitCommandResult,
  args: string[],
): GitCommandResult {
  if (result.exitCode === 0) {
    return result;
  }

  const command = `git ${args.join(" ")}`;
  const stderr = result.stderr.trim();
  throw new Error(
    stderr
      ? `${command} failed: ${stderr}`
      : `${command} failed with exit code ${result.exitCode}`,
  );
}

function getDiffErrorLabel(diffType: DiffType, cwd?: string): string {
  if (cwd) {
    return "Worktree error";
  }

  if (diffType.startsWith("stack:")) {
    return "Error: stack";
  }

  return `Error: ${diffType}`;
}

export async function runGitDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string = "main",
  externalCwd?: string,
): Promise<DiffResult> {
  let patch = "";
  let label = "";
  let cwd: string | undefined = externalCwd;
  let effectiveDiffType = diffType as string;

  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) {
      return {
        patch: "",
        label: "Worktree error",
        error: "Could not parse worktree diff type",
      };
    }
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  try {
    const stackDiff = parseStackDiffType(effectiveDiffType);
    if (stackDiff) {
      const args = [
        "diff",
        "--no-ext-diff",
        `${stackDiff.baseRef}..${stackDiff.headRef}`,
        "--src-prefix=a/",
        "--dst-prefix=b/",
      ];
      const result = assertGitSuccess(await runtime.runGit(args, { cwd }), args);
      patch = result.stdout;
      label = stackDiff.label;
    } else {
      switch (effectiveDiffType) {
        case "uncommitted": {
          const trackedDiffArgs = [
            "diff",
            "--no-ext-diff",
            "HEAD",
            "--src-prefix=a/",
            "--dst-prefix=b/",
          ];
          const hasHead =
            (await runtime.runGit(["rev-parse", "--verify", "HEAD"], { cwd }))
              .exitCode === 0;
          const trackedPatch = hasHead
            ? assertGitSuccess(
                await runtime.runGit(trackedDiffArgs, { cwd }),
                trackedDiffArgs,
              ).stdout
            : "";
          const untrackedDiff = await getUntrackedFileDiffs(
            runtime,
            "a/",
            "b/",
            cwd,
          );
          patch = trackedPatch + untrackedDiff;
          label = "Uncommitted changes";
          break;
        }

        case "staged": {
          const stagedDiffArgs = [
            "diff",
            "--no-ext-diff",
            "--staged",
            "--src-prefix=a/",
            "--dst-prefix=b/",
          ];
          const stagedDiff = assertGitSuccess(
            await runtime.runGit(stagedDiffArgs, { cwd }),
            stagedDiffArgs,
          );
          patch = stagedDiff.stdout;
          label = "Staged changes";
          break;
        }

        case "unstaged": {
          const trackedDiffArgs = [
            "diff",
            "--no-ext-diff",
            "--src-prefix=a/",
            "--dst-prefix=b/",
          ];
          const trackedDiff = assertGitSuccess(
            await runtime.runGit(trackedDiffArgs, { cwd }),
            trackedDiffArgs,
          );
          const untrackedDiff = await getUntrackedFileDiffs(
            runtime,
            "a/",
            "b/",
            cwd,
          );
          patch = trackedDiff.stdout + untrackedDiff;
          label = "Unstaged changes";
          break;
        }

        case "last-commit": {
          const hasParent = await runtime.runGit(
            ["rev-parse", "--verify", "HEAD~1"],
            { cwd },
          );
          const args =
            hasParent.exitCode === 0
              ? [
                  "diff",
                  "--no-ext-diff",
                  "HEAD~1..HEAD",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                ]
              : [
                  "diff",
                  "--no-ext-diff",
                  "--root",
                  "HEAD",
                  "--src-prefix=a/",
                  "--dst-prefix=b/",
                ];
          const lastCommitDiff = assertGitSuccess(
            await runtime.runGit(args, { cwd }),
            args,
          );
          patch = lastCommitDiff.stdout;
          label = "Last commit";
          break;
        }

        case "branch": {
          const branchDiffArgs = [
            "diff",
            "--no-ext-diff",
            `${defaultBranch}..HEAD`,
            "--src-prefix=a/",
            "--dst-prefix=b/",
          ];
          const branchDiff = assertGitSuccess(
            await runtime.runGit(branchDiffArgs, { cwd }),
            branchDiffArgs,
          );
          patch = branchDiff.stdout;
          label = `Changes vs ${defaultBranch}`;
          break;
        }

        case "merge-base": {
          const mergeBaseResult = assertGitSuccess(
            await runtime.runGit(["merge-base", defaultBranch, "HEAD"], { cwd }),
            ["merge-base", defaultBranch, "HEAD"],
          );
          const mergeBase = mergeBaseResult.stdout.trim();
          const mergeBaseDiffArgs = [
            "diff",
            "--no-ext-diff",
            `${mergeBase}..HEAD`,
            "--src-prefix=a/",
            "--dst-prefix=b/",
          ];
          const mergeBaseDiff = assertGitSuccess(
            await runtime.runGit(mergeBaseDiffArgs, { cwd }),
            mergeBaseDiffArgs,
          );
          patch = mergeBaseDiff.stdout;
          label = `PR diff vs ${defaultBranch}`;
          break;
        }

        default:
          return { patch: "", label: "Unknown diff type" };
      }
    }
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const firstLine = raw.split("\n").find((line) => line.trim().length > 0) ?? raw;
    const message =
      firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
    return {
      patch: "",
      label: getDiffErrorLabel(diffType, cwd),
      error: message,
    };
  }

  if (cwd) {
    const branch = await getCurrentBranch(runtime, cwd);
    if (branch && branch !== "HEAD") {
      label = `${branch}: ${label}`;
    } else {
      label = `${cwd.split("/").pop()}: ${label}`;
    }
  }

  return { patch, label };
}

export async function runGitDiffWithContext(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  gitContext: GitContext,
): Promise<DiffResult> {
  return runGitDiff(runtime, diffType, gitContext.defaultBranch, gitContext.cwd);
}

export async function getFileContentsForDiff(
  runtime: ReviewGitRuntime,
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  const oldFilePath = oldPath || filePath;

  let effectiveDiffType = diffType as string;
  if (diffType.startsWith("worktree:")) {
    const parsed = parseWorktreeDiffType(diffType);
    if (!parsed) {
      return { oldContent: null, newContent: null };
    }
    cwd = parsed.path;
    effectiveDiffType = parsed.subType;
  }

  async function gitShow(ref: string, path: string): Promise<string | null> {
    const result = await runtime.runGit(["show", `${ref}:${path}`], { cwd });
    return result.exitCode === 0 ? result.stdout : null;
  }

  async function readWorkingTree(path: string): Promise<string | null> {
    const fullPath = cwd ? resolvePath(cwd, path) : path;
    return runtime.readTextFile(fullPath);
  }

  const stackDiff = parseStackDiffType(effectiveDiffType);
  if (stackDiff) {
    return {
      oldContent: await gitShow(stackDiff.baseRef, oldFilePath),
      newContent: await gitShow(stackDiff.headRef, filePath),
    };
  }

  switch (effectiveDiffType) {
    case "uncommitted":
      return {
        oldContent: await gitShow("HEAD", oldFilePath),
        newContent: await readWorkingTree(filePath),
      };
    case "staged":
      return {
        oldContent: await gitShow("HEAD", oldFilePath),
        newContent: await gitShow(":0", filePath),
      };
    case "unstaged":
      return {
        oldContent: await gitShow(":0", oldFilePath),
        newContent: await readWorkingTree(filePath),
      };
    case "last-commit":
      return {
        oldContent: await gitShow("HEAD~1", oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    case "branch":
      return {
        oldContent: await gitShow(defaultBranch, oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    case "merge-base": {
      const mbResult = await runtime.runGit(["merge-base", defaultBranch, "HEAD"], {
        cwd,
      });
      const mb = mbResult.exitCode === 0 ? mbResult.stdout.trim() : defaultBranch;
      return {
        oldContent: await gitShow(mb, oldFilePath),
        newContent: await gitShow("HEAD", filePath),
      };
    }
    default:
      return { oldContent: null, newContent: null };
  }
}

export function validateFilePath(filePath: string): void {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    throw new Error("Invalid file path");
  }
}

async function ensureGitSuccess(
  runtime: ReviewGitRuntime,
  args: string[],
  cwd?: string,
): Promise<void> {
  const result = await runtime.runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
}

export async function gitAddFile(
  runtime: ReviewGitRuntime,
  filePath: string,
  cwd?: string,
): Promise<void> {
  validateFilePath(filePath);
  await ensureGitSuccess(runtime, ["add", "--", filePath], cwd);
}

export async function gitResetFile(
  runtime: ReviewGitRuntime,
  filePath: string,
  cwd?: string,
): Promise<void> {
  validateFilePath(filePath);
  await ensureGitSuccess(runtime, ["reset", "HEAD", "--", filePath], cwd);
}

export function parseP4DiffType(
  diffType: string,
): { changelist: string | "default" } | null {
  if (diffType === "p4-default") {
    return { changelist: "default" };
  }
  if (diffType.startsWith("p4-changelist:")) {
    return { changelist: diffType.slice("p4-changelist:".length) };
  }
  return null;
}

export function isP4DiffType(diffType: string): boolean {
  return parseP4DiffType(diffType) !== null;
}
