import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  makeManualOnlyProviderMaintenanceCapabilities,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilitiesResolver,
  type ProviderMaintenanceResolutionContext,
} from "@t3tools/provider-core/server/maintenanceResolver";

const DRIVER_KIND = ProviderDriverKind.make("pi");
export const PI_NPM_PACKAGE = "@earendil-works/pi-coding-agent";

const officialPiMaintenance = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: PI_NPM_PACKAGE,
  nativeUpdate: { args: ["update", "--self"] },
});

function commandBasename(commandPath: string): string {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.slice(normalized.lastIndexOf("/") + 1).replace(/\.(?:exe|cmd|bat|ps1)$/, "");
}

/**
 * The official CLI is either launched as `pi` or resolves into its npm
 * package. Anything else (a fork such as `aside-code`, a wrapper script) is
 * versioned independently, so Pi's registry release says nothing about it.
 */
export function isOfficialPiCommand(
  context: Pick<ProviderMaintenanceResolutionContext, "resolvedCommandPath" | "realCommandPath">,
): boolean {
  const commandPaths = [context.resolvedCommandPath, context.realCommandPath];
  if (commandPaths.some((commandPath) => commandBasename(commandPath) === "pi")) return true;
  const packageSegment = `/node_modules/${PI_NPM_PACKAGE}/`;
  return commandPaths.some((commandPath) =>
    normalizeCommandPath(commandPath).includes(packageSegment),
  );
}

/**
 * A custom binary gets no package, latest version, or update command, so its
 * version advisory stays unknown instead of comparing it against Pi's npm
 * release and offering `update --self` on someone else's executable.
 */
export const piMaintenance: ProviderMaintenanceCapabilitiesResolver = {
  resolve: (context) =>
    context !== null && !isOfficialPiCommand(context)
      ? Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
        )
      : officialPiMaintenance.resolve(context),
};
