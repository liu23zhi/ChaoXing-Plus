#!/usr/bin/env python3
"""Exercise the actual workflow guard; never execute a build or client."""
import copy
import importlib.util
from pathlib import Path
import unittest

import yaml

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("workflow_guard", HERE / "check-joint-workflow.py")
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

ENTRIES = (
    "windows/native-source/build-windows.cmd",
    "windows/native-source/build-windows.ps1",
    "windows/native-source/build-windows.sh",
    "windows/hook-source/build-proxy.ps1",
)


class WindowsBuildWorkflowTest(unittest.TestCase):
    def setUp(self):
        self.workflow = yaml.load(
            (HERE.parents[1] / ".github/workflows/ci.yml").read_text(encoding="utf-8"),
            Loader=yaml.BaseLoader,
        )

    def test_committed_workflow_passes(self):
        self.assertEqual([], guard.validate(self.workflow))

    def test_each_entry_must_be_invoked_and_cannot_be_echoed_or_missing(self):
        for entry in ENTRIES:
            with self.subTest(entry=entry):
                workflow = copy.deepcopy(self.workflow)
                steps = workflow["jobs"]["windows-contract"]["steps"]
                for step in steps:
                    if entry in step.get("run", ""):
                        step["run"] = f"Write-Output '{entry}'"
                errors = guard.validate(workflow)
                self.assertIn(f"windows-contract: missing required Windows build {entry}", errors)

    def test_each_entry_must_run_after_other_step_failure_and_cannot_soft_fail(self):
        for entry in ENTRIES:
            with self.subTest(entry=entry):
                workflow = copy.deepcopy(self.workflow)
                steps = workflow["jobs"]["windows-contract"]["steps"]
                entry_steps = [step for step in steps if entry in step.get("run", "")]
                self.assertEqual(1, len(entry_steps))
                for key, value in (("if", "${{ success() }}"), ("continue-on-error", "true")):
                    with self.subTest(option=key):
                        entry_steps[0][key], original = value, entry_steps[0].get(key)
                        errors = guard.validate(workflow)
                        self.assertIn(f"windows-contract: Windows build must not be skipped or soft-fail: {entry}", errors)
                        if original is None:
                            del entry_steps[0][key]
                        else:
                            entry_steps[0][key] = original


if __name__ == "__main__":
    unittest.main()
