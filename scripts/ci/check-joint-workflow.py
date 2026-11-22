#!/usr/bin/env python3
"""Check the shape of the joint PR gate. Does not execute any workflow step."""
import re
import sys
import json
from pathlib import Path

import yaml

STACK = {"source-checks", "service-contract", "windows-contract", "joint-gate"}
REQUIRED_RUN = {
    "source-checks": ("npm run typecheck", "npm run build", "owned-unit", "check-joint-workflow.py"),
    "service-contract": ("three-mode-contract.test.mjs",),
    "windows-contract": ("npm run build", "extension-diagnostics.browser.test.mjs", "owned-profiles.browser.test.mjs", "owned-native-contracts.ps1"),
}
def validate(workflow):
    errors = []
    def require(condition, message):
        if not condition:
            errors.append(message)
    events = workflow.get("on", {})
    require(isinstance(events, dict) and set(events) == {"push", "pull_request", "workflow_dispatch"},
            "expected only main push, main PR and input-free manual dispatch")
    if isinstance(events, dict):
        for event in ("push", "pull_request"):
            require(events.get(event) == {"branches": ["main"]}, f"{event}: modes must not be path-filtered")
        require(events.get("workflow_dispatch") in ({}, "", None), "no dispatch input for third-party clients")
    require(workflow.get("permissions") == {"contents": "read"}, "workflow must be read-only")
    jobs = workflow.get("jobs", {})
    if not isinstance(jobs, dict):
        return errors + ["missing jobs"]
    require(set(jobs) == STACK, "expected three first-party checks and one shared merge gate")
    for job_id, job in jobs.items():
        require("uses" not in job and "permissions" not in job and "secrets" not in job,
                f"{job_id}: no delegated workflow or privilege override")
        for step in job.get("steps", []):
            action = step.get("uses")
            if action:
                require(bool(re.fullmatch(r"actions/(checkout|setup-node|setup-go)@[0-9a-f]{40}", action)),
                        f"{job_id}: only pinned official setup/checkout actions")
            if action and action.startswith("actions/checkout@"):
                opts = step.get("with", {})
                require(opts.get("persist-credentials") == "false" and not ({"lfs", "submodules"} & set(opts)),
                        f"{job_id}: checkout source only, without credentials or external assets")
                if "repository" in opts:
                    require(job_id == "service-contract" and opts["repository"] == "liu23zhi/TiKuHelper"
                            and bool(re.fullmatch(r"[0-9a-f]{40}", opts.get("ref", ""))),
                            "service fixture must use a pinned first-party checkout")
    require("secrets." not in json.dumps(workflow).lower(), "joint CI does not require repository secrets")
    final = jobs.get("joint-gate", {})
    require(set(final.get("needs", [])) == STACK - {"joint-gate"}, "gate must wait for all three checks")
    require(final.get("if") in ("always()", "$" + "{{ always() }}"), "gate must run even on failed/skipped needs")
    require("continue-on-error" not in final, "gate cannot mask a failure")
    for name in sorted(STACK - {"joint-gate"}):
        job = jobs.get(name, {})
        require("if" not in job and "continue-on-error" not in job, f"{name}: conditional gate/ignored error")
        steps = job.get("steps", [])
        require(all("if" not in step and "continue-on-error" not in step for step in steps),
                f"{name}: core steps must not be skipped or soft-fail")
        runs = "\n".join(str(step.get("run", "")) for step in steps)
        for command in REQUIRED_RUN[name]:
            require(command in runs, f"{name}: missing required check {command}")
    return errors
def main():
    path = Path(sys.argv[1]) if len(sys.argv) == 2 else Path(".github/workflows/ci.yml")
    # BaseLoader keeps YAML 1.1's 'on' as a string, as GitHub Actions does.
    check = validate(yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader))
    if check:
        print("Not a joint first-party workflow:\n- " + "\n- ".join(check), file=sys.stderr)
        return 1
    print("OK: source, three-mode service, and Windows browser/native checks are required together")
    return 0
if __name__ == "__main__":
    sys.exit(main())
