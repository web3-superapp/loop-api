import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as adapterModule from "../server/app-integrations-p0/adapter.mjs";

const { createProductionAdapters } = adapterModule;
if (Object.keys(adapterModule).sort().join(",") !== "createOfflineFixtureAdapters,createProductionAdapters") {
  throw new Error(`unexpected public adapter exports: ${Object.keys(adapterModule).sort()}`);
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const adapter = resolve(root, "server/app-integrations-p0/adapter.mjs");
const credentials = Object.fromEntries([
  "PRIVY_APP_ID", "PRIVY_VERIFICATION_KEY_REF", "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_REF", "COURIER_API_KEY_REF", "TRIGGER_SECRET_KEY_REF",
].map((key) => [key, `test-ref-${key}`]));
const rawPorts = Object.freeze({
  verifyPrivyAccessToken: async () => ({ privyDid: "did:privy:test" }),
  verifyProviderEventRaw: async () => ({}),
  supabaseSelect: async () => [],
  supabaseUpsert: async () => ({}),
  courierIssueUserToken: async () => ({}),
  courierSend: async () => ({}),
  triggerSchedule: async () => ({}),
  readServerTimeMs: () => Date.now(),
});

function expectCode(run, code) {
  try {
    run();
  } catch (error) {
    if (error?.message === code) return;
    throw new Error(`expected ${code}, received ${error?.message}`);
  }
  throw new Error(`expected ${code}, call succeeded`);
}

expectCode(() => createProductionAdapters({
  contractStatus: "RUNTIME_ENABLED_AFTER_CREDENTIALED_GATES",
  credentials,
  officialSdkPorts: rawPorts,
}), "PRODUCTION_ENABLEMENT_CAPABILITY_REQUIRED");
expectCode(() => createProductionAdapters(Object.freeze({}), {
  credentials,
  officialSdkPorts: rawPorts,
}), "PRODUCTION_ENABLEMENT_CAPABILITY_REQUIRED");

const selfTest = spawnSync(process.execPath, [adapter, "--self-test"], {
  cwd: root, encoding: "utf8",
});
if (selfTest.error) {
  throw new Error(`adapter self-test spawn failed: ${selfTest.error.stack || selfTest.error}`);
}
const selfTestDiagnostics = `exit=${selfTest.status} signal=${selfTest.signal} stdout=${JSON.stringify(selfTest.stdout)} stderr=${JSON.stringify(selfTest.stderr)}`;
if (selfTest.status !== 0 || selfTest.signal !== null) {
  throw new Error(`adapter self-test failed: ${selfTestDiagnostics}`);
}
if (selfTest.stdout.trim() !== "PASS app-integrations-p0 v3 adapter self-test: typed_rows courier_idempotency authoritative_clock one_shot_capability credential_whitespace") {
  throw new Error(`unexpected adapter self-test output: ${selfTestDiagnostics}`);
}

process.stdout.write("PASS app-integrations-p0 v3 black-box runtime\n");
