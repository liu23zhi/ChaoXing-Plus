import { register } from "node:module";
import { pathToFileURL } from "node:url";
register("./scripts/ci/ts-source-hooks.mjs", pathToFileURL("./"));
