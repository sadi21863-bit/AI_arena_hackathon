/**
 * Build-turn dispatch — spec §8: "the Cloudflare Worker calls GitHub's
 * REST API to start a workflow run." Triggers team-build-turn.yml's
 * workflow_dispatch on a team's own repo (created by github/repos.ts).
 */

import type { Env } from "../env";
import { githubRequest } from "./client";

export interface DispatchBuildTurnInput {
  repoFullName: string; // "org/repo"
  team: "alpha" | "beta";
  turnId: string;
  taskPrompt: string;
}

export async function dispatchBuildTurn(env: Env, input: DispatchBuildTurnInput): Promise<void> {
  const [owner, repo] = input.repoFullName.split("/");
  // "main", not "master": team repos are created without auto_init
  // (github/repos.ts) so GitHub picks the account/org's configured default
  // branch name for the first commit, which is "main" here — distinct from
  // this management repo's own "master" default (found live, 2026-07-21,
  // team_formation's third run: dispatch 422'd with "No ref found: master").
  await githubRequest(env, "POST", `/repos/${owner}/${repo}/actions/workflows/team-build-turn.yml/dispatches`, {
    ref: "main",
    inputs: {
      team: input.team,
      turn_id: input.turnId,
      task_prompt: input.taskPrompt,
    },
  });
}

export interface BuildTurnRunStatus {
  runId: number;
  status: string; // "queued" | "in_progress" | "completed"
  conclusion: string | null; // "success" | "failure" | ... | null while not completed
  htmlUrl: string;
  /** Run title — carries the turn_id via the workflow's `run-name`, which is
   *  the only way to correlate a run back to the turn that dispatched it
   *  (the Actions API can't filter by workflow_dispatch input). Empty for
   *  runs from team repos created before `run-name` was added. */
  name: string;
  headSha: string | null;
  createdAt: string | null;
}

/**
 * Observatory build view (spec §11: "polls GitHub Actions job status ...
 * rather than holding a live connection"). Returns the most recent runs
 * for the team-build-turn workflow on a repo — the caller matches by
 * turn_id via the run's display name/inputs if it needs a specific turn,
 * since the Actions API doesn't let you query by workflow_dispatch input.
 */
export async function listBuildTurnRuns(env: Env, repoFullName: string, perPage = 10): Promise<BuildTurnRunStatus[]> {
  const [owner, repo] = repoFullName.split("/");
  const data = await githubRequest(
    env, "GET",
    `/repos/${owner}/${repo}/actions/workflows/team-build-turn.yml/runs?per_page=${perPage}`
  );
  return (data.workflow_runs ?? []).map((run: any) => ({
    runId: run.id,
    status: run.status,
    conclusion: run.conclusion,
    htmlUrl: run.html_url,
    // display_title reflects `run-name`; `name` is the workflow's own name
    // and is the fallback for runs predating it.
    name: run.display_title ?? run.name ?? "",
    headSha: run.head_sha ?? null,
    createdAt: run.created_at ?? null,
  }));
}
