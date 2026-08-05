import { MEDUSA_CLI_PATH, MedusaAppLoader, Migrator } from "@medusajs/framework"
import { LinkLoader } from "@medusajs/framework/links"
import {
  ContainerRegistrationKeys,
  getResolvedPlugins,
  isDefined,
  mergePluginModules,
} from "@medusajs/framework/utils"
import { Logger, MedusaContainer } from "@medusajs/types"
import { fork } from "child_process"
import path, { join } from "path"
import { initializeContainer } from "../../loaders"
import { ensureDbExists, isPgstreamEnabled } from "../utils"
import { syncCustomFields } from "./sync-custom-fields"
import { syncLinks } from "./sync-links"

const TERMINAL_SIZE = process.stdout.columns

const cliPath = path.resolve(MEDUSA_CLI_PATH, "..", "..", "cli.js")

/**
 * A low-level utility to migrate the database. This util should
 * never exit the process implicitly.
 */
export async function migrate({
  directory,
  skipLinks,
  skipCustomFields,
  skipScripts,
  executeAllLinks,
  executeSafeLinks,
  executeAllCustomFields,
  executeSafeCustomFields,
  allOrNothing,
  concurrency,
  logger,
  container,
}: {
  directory: string
  skipLinks: boolean
  skipCustomFields?: boolean
  skipScripts: boolean
  executeAllLinks: boolean
  executeSafeLinks: boolean
  executeAllCustomFields?: boolean
  executeSafeCustomFields?: boolean
  allOrNothing?: boolean
  concurrency?: number
  logger: Logger
  container: MedusaContainer
}): Promise<boolean> {
  /**
   * Setup
   */

  await ensureDbExists(container)

  // If pgstream is enabled, force concurrency to 1
  const pgstreamEnabled = await isPgstreamEnabled(container)
  if (pgstreamEnabled) {
    concurrency = 1
  }

  if (isDefined(concurrency)) {
    process.env.DB_MIGRATION_CONCURRENCY = String(concurrency)
  }

  const medusaAppLoader = new MedusaAppLoader()
  const configModule = container.resolve(
    ContainerRegistrationKeys.CONFIG_MODULE
  )

  const plugins = await getResolvedPlugins(directory, configModule, true)
  mergePluginModules(configModule, plugins)

  const linksSourcePaths = plugins.map((plugin) =>
    join(plugin.resolve, "links")
  )
  await new LinkLoader(linksSourcePaths, logger).load()

  /**
   * Run migrations
   */
  logger.info("Running migrations...")

  const migrator = new Migrator({ container })
  await migrator.ensureMigrationsTable()

  await medusaAppLoader.runModulesMigrations({
    action: "run",
    allOrNothing,
  })
  logger.log(new Array(TERMINAL_SIZE).join("-"))
  logger.info("Migrations completed")

  /**
   * Sync links
   */
  if (!skipLinks) {
    logger.log(new Array(TERMINAL_SIZE).join("-"))
    await syncLinks(medusaAppLoader, {
      executeAll: executeAllLinks,
      executeSafe: executeSafeLinks,
      directory,
      container,
      concurrency,
    })
  }

  /**
   * Sync custom field satellite tables. Same rationale as links: the tables are
   * derived from project configuration, so they cannot ship as migration files.
   */
  if (!skipCustomFields) {
    logger.log(new Array(TERMINAL_SIZE).join("-"))
    // Deliberately not the links flags: consenting to destructive link-table
    // changes must not silently extend to dropping or converting custom field
    // columns.
    await syncCustomFields(container, {
      executeAll: executeAllCustomFields,
      executeSafe: executeSafeCustomFields,
    })
  }

  if (!skipScripts) {
    /**
     * Run migration scripts
     */
    logger.log(new Array(TERMINAL_SIZE).join("-"))
    const childProcess = fork(cliPath, ["db:migrate:scripts"], {
      cwd: directory,
      env: process.env,
    })

    await new Promise<void>((resolve, reject) => {
      childProcess.on("error", (error) => {
        reject(error)
      })
      childProcess.on("close", () => {
        resolve()
      })
    })
  }

  return true
}

const main = async function ({
  directory,
  skipLinks,
  skipCustomFields,
  skipScripts,
  executeAllLinks,
  executeSafeLinks,
  executeAllCustomFields,
  executeSafeCustomFields,
  concurrency,
  allOrNothing,
}) {
  process.env.MEDUSA_WORKER_MODE = "server"
  let logger: Logger | undefined

  try {
    const container = await initializeContainer(directory)
    logger = container.resolve(ContainerRegistrationKeys.LOGGER)

    const migrated = await migrate({
      directory,
      skipLinks,
      skipCustomFields,
      skipScripts,
      executeAllLinks,
      executeSafeLinks,
      executeAllCustomFields,
      executeSafeCustomFields,
      concurrency,
      allOrNothing,
      logger,
      container,
    })
    process.exit(migrated ? 0 : 1)
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
