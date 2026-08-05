import {
  ContainerRegistrationKeys,
  Modules,
  FeatureFlag,
  getResolvedPlugins,
  mergePluginModules,
} from "@medusajs/framework/utils"
import checkbox from "@inquirer/checkbox"
import boxen from "boxen"
import chalk from "chalk"
import { ConfigModule, Logger, MedusaContainer } from "@medusajs/types"
import { initializeContainer } from "../../loaders"
import { ensureDbExists } from "../utils"
// Type-only, so nothing is required at load time.
import type { SatelliteAction } from "@medusajs/custom-fields"
import CustomFieldsFeatureFlag from "../../feature-flags/custom-fields"

/**
 * Read the custom fields module's options straight from the config.
 *
 * Configuration is the source of truth for definitions, and migration commands
 * do not fully load module services, so going through the config avoids
 * depending on module resolution here.
 */
function resolveOptions(configModule: ConfigModule) {
  const modules = configModule.modules ?? {}
  const declaration = modules[Modules.CUSTOM_FIELDS] as
    | { disable?: boolean; options?: any }
    | undefined

  if (!declaration || declaration.disable) {
    return undefined
  }

  return declaration.options
}

/**
 * Bring satellite tables in line with the configured custom fields.
 *
 * Satellite tables are derived from a project's configuration, so they cannot
 * ship as migration files inside the module package. Link tables have the same
 * property and Medusa already answers it with `db:sync-links` — a planner that
 * diffs against the live schema and runs from the CLI. This is the same shape
 * applied to custom fields.
 */
export async function syncCustomFields(
  container: MedusaContainer,
  {
    executeAll = false,
    executeSafe = false,
  }: { executeAll?: boolean; executeSafe?: boolean } = {}
): Promise<SatelliteAction[]> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)

  if (!FeatureFlag.isFeatureEnabled(CustomFieldsFeatureFlag.key)) {
    return []
  }

  const configModule: ConfigModule = container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE
  )

  // Loaded lazily so the custom fields package is only pulled in when the
  // feature is actually enabled, and so the CLI's import graph does not reach
  // into a module package at load time.
  const {
    buildSatellites,
    executeSatellitePlan,
    planSatellites,
    resolveDefinitions,
  } = await import("@medusajs/custom-fields")

  const options = resolveOptions(configModule)
  const definitionsByEntity = resolveDefinitions(options)

  if (!definitionsByEntity.size) {
    return []
  }

  const knex = container.resolve(ContainerRegistrationKeys.PG_CONNECTION)

  logger.info("Syncing custom fields...")

  // The satellites are the same DML entities the module builds at boot, so the
  // schema is planned against the one description of the table rather than a
  // second, hand-written one.
  const satellites = new Map(
    buildSatellites(definitionsByEntity).map((satellite, i) => [
      [...definitionsByEntity.keys()][i],
      satellite,
    ])
  )

  const plans = await planSatellites(options, satellites)

  const safe = plans.filter(
    (plan) => plan.action === "create" || plan.action === "update"
  )
  let unsafe = plans.filter((plan) => plan.action === "notify")

  /**
   * Anything that drops a column or converts one in place can lose data, so it
   * is never applied on its own. Same handling as `db:sync-links`:
   * `--execute-safe` skips it entirely, `--execute-all` takes it all, and
   * otherwise the tables are offered for selection.
   */
  if (unsafe.length) {
    for (const plan of unsafe) {
      for (const warning of plan.warnings ?? []) {
        logger.warn(warning)
      }
    }

    if (executeSafe) {
      unsafe = []
    } else if (!executeAll) {
      unsafe = await askForCustomFieldActionsToPerform(unsafe, logger)
    }
  }

  for (const plan of safe) {
    await executeSatellitePlan(knex, [plan])
    logger.info(
      `${plan.action === "create" ? "Created" : "Updated"} "${plan.table}"`
    )
  }

  for (const plan of unsafe) {
    await executeSatellitePlan(knex, [{ ...plan, action: "update" }])
    logger.info(`Updated "${plan.table}"`)
  }

  return plans
}

/**
 * Offer the tables whose plan is destructive, showing the statements that would
 * run rather than only the table name — the difference between converting a
 * column and dropping it matters, and both arrive as "notify".
 */
async function askForCustomFieldActionsToPerform(
  actions: SatelliteAction[],
  logger: Logger
): Promise<SatelliteAction[]> {
  logger.info(
    boxen(
      `Select the tables to ${chalk.red(
        "MODIFY"
      )}. The following changes can lose data`,
      { borderColor: "red", padding: 1 }
    )
  )

  return await checkbox({
    message: "Select tables to act upon",
    instructions: chalk.dim(
      " <space> select, <a> select all, <i> inverse, <enter> submit"
    ),
    choices: actions.map((action) => ({
      name: `${action.table}\n${action.sql
        .split("\n")
        .filter(Boolean)
        .map((statement) => `      ${chalk.dim(statement)}`)
        .join("\n")}`,
      value: action,
      checked: false,
    })),
  })
}

const main = async function ({ directory, executeSafe, executeAll }) {
  let logger: Logger | undefined

  try {
    const container = await initializeContainer(directory)
    logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    await ensureDbExists(container)

    const configModule = container.resolve(
      ContainerRegistrationKeys.CONFIG_MODULE
    )

    // Plugins may register the custom fields module with their own options, so
    // merge them in before reading the configuration.
    const plugins = await getResolvedPlugins(directory, configModule, true)
    mergePluginModules(configModule, plugins)

    const plans = await syncCustomFields(container, {
      executeAll,
      executeSafe,
    })

    if (!plans.length) {
      logger.info("No custom fields configured. Nothing to sync.")
    } else if (plans.every((plan) => plan.action === "noop")) {
      logger.info("Custom fields are already in sync.")
    }

    process.exit()
  } catch (error) {
    if (logger) {
      logger.error(error as string | Error)
    } else {
      console.error(error)
    }
    process.exit(1)
  }
}

export default main
