import { MikroORM } from "@medusajs/framework/mikro-orm/core"
import {
  DatabaseSchema,
  PostgreSqlDriver,
} from "@medusajs/framework/mikro-orm/postgresql"
import {
  DALUtils,
  ModulesSdkUtils,
  normalizeMigrationSQL,
  toMikroOrmEntities,
} from "@medusajs/framework/utils"
import { DmlEntity } from "@medusajs/framework/utils"
import { Modules } from "@medusajs/framework/utils"

import { satelliteTableName } from "./satellite"

export type SatelliteAction = {
  entity: string
  table: string
  action: "create" | "update" | "noop" | "notify"
  sql: string
  /**
   * Populated for `notify`: why it is not applied without confirmation.
   */
  warnings?: string[]
}

/**
 * Statements that can lose data, so they are never run without a human saying
 * so. Same list the link module uses, and it is what makes a *type* change
 * surface as a prompt: MikroORM emits `alter column` for one.
 */
const UNSAFE_SQL_COMMANDS = ["alter column", "drop column"]

/**
 * Columns the satellite manages itself, which the diff should leave alone.
 */
const IGNORED_COLUMNS = ["created_at", "updated_at", "deleted_at"]

/**
 * Keep only the statements naming the table this module owns.
 *
 * A hard blast-radius guard: whatever the generator produces, nothing can be
 * emitted against a table belonging to another module. Lifted from the link
 * module's planner, which is private to it.
 */
function pickTableRelatedCommands(table: string, sql: string): string {
  return sql
    .split(";")
    .filter((command) => {
      const cmd = command.trim()
      return (
        cmd.length &&
        cmd !== "set names 'utf8'" &&
        cmd.includes(`"${table}"`) &&
        !IGNORED_COLUMNS.some((column) => cmd.includes(`column "${column}"`))
      )
    })
    .map((command) => `${command.trim()};`)
    .join("\n")
}

async function tableExists(
  orm: MikroORM<PostgreSqlDriver>,
  table: string,
  schema: string
): Promise<boolean> {
  const rows = await orm.em
    .getConnection()
    .execute(
      `select 1 from information_schema.tables where table_name = ? and table_schema = ?`,
      [table, schema]
    )

  return !!(rows as unknown[])?.length
}

/**
 * Diff one satellite entity against the live schema.
 *
 * The satellite is a DML entity, so rather than hand-writing DDL and
 * hand-diffing it, this hands the entity to MikroORM and uses its schema
 * generator purely as a **SQL producer** — never as an executor. That is the
 * shape the link module already uses for tables it defines at runtime
 * (`link-modules/src/migration/index.ts:279`), and it matters for more than
 * code size: the entity becomes the single description of the table. When the
 * DDL was written by hand alongside the entity, the two drifted — `number`
 * built an `integer` property and a `numeric` column, and values came back as
 * strings.
 *
 * It also means type changes are detected for free. A hand-rolled diff on
 * column *names* cannot see one; the generator emits `alter column ... type`,
 * which lands in {@link UNSAFE_SQL_COMMANDS} and therefore in `notify`.
 */
export async function planSatellite(
  dbConfig: any,
  entity: string,
  satellite: DmlEntity<any, any>
): Promise<SatelliteAction> {
  const table = satelliteTableName(entity)
  const schema = dbConfig.schema || "public"

  const [mikroEntity] = toMikroOrmEntities([satellite])
  const orm: MikroORM<PostgreSqlDriver> =
    await DALUtils.mikroOrmCreateConnection(dbConfig, [mikroEntity], "")

  try {
    const generator = orm.getSchemaGenerator()
    const platform = orm.em.getPlatform()
    const connection = orm.em.getConnection()

    if (!(await tableExists(orm, table, schema))) {
      return {
        entity,
        table,
        action: "create",
        sql: normalizeMigrationSQL(await generator.getCreateSchemaSQL()),
      }
    }

    /**
     * @note `loadInformationSchema` mutates the schema passed as its first
     * argument.
     */
    const dbSchema = new DatabaseSchema(platform, schema)
    await platform
      .getSchemaHelper?.()
      ?.loadInformationSchema(dbSchema, connection, [
        { table_name: table, schema_name: schema },
      ])

    const sql = pickTableRelatedCommands(
      table,
      normalizeMigrationSQL(
        await generator.getUpdateSchemaSQL({ fromSchema: dbSchema })
      )
    )

    if (!sql.length) {
      return { entity, table, action: "noop", sql: "" }
    }

    const unsafe = UNSAFE_SQL_COMMANDS.filter((fragment) =>
      sql.match(new RegExp(fragment, "ig"))
    )

    if (!unsafe.length) {
      return { entity, table, action: "update", sql }
    }

    return {
      entity,
      table,
      action: "notify",
      sql,
      warnings: unsafe.map((fragment) =>
        fragment === "drop column"
          ? `"${table}" has a column with no matching definition. Dropping it deletes its data.`
          : `"${table}" has a column whose type no longer matches its definition. Converting it may fail, or may lose precision.`
      ),
    }
  } finally {
    await orm.close(true)
  }
}

export async function planSatellites(
  options: any,
  satellites: Map<string, DmlEntity<any, any>>
): Promise<SatelliteAction[]> {
  const dbConfig = ModulesSdkUtils.loadDatabaseConfig(
    Modules.CUSTOM_FIELDS,
    options
  )

  const plans: SatelliteAction[] = []
  for (const [entity, satellite] of satellites) {
    plans.push(await planSatellite(dbConfig, entity, satellite))
  }

  return plans
}

/**
 * Apply a plan. `notify` actions are skipped unless the caller has explicitly
 * promoted them to `update` after confirming what would happen.
 */
export async function executeSatellitePlan(
  knex: any,
  actions: SatelliteAction[]
): Promise<void> {
  for (const action of actions) {
    if (action.action === "noop" || action.action === "notify" || !action.sql) {
      continue
    }

    await knex.raw(action.sql)
  }
}
